// Data health: identifiers, counts and repair hints only, never event or note content.
// The hourly `health` task (opt-in via MAINTENANCE_TASKS) keeps a rolling R2/D1 list-diff
// in health_state; everything else is computed on request from O(1) or bounded queries,
// and every table added by another track is looked up in sqlite_master first.
import type { Allotment, MaintenanceTask } from './maintenance';
import { MaintenanceError } from './maintenance-error';
import { Env, HttpError, json } from './types';
import { backupIntervalHours, backupMaxAgeDays, iso, quoted, scheduledTask, tableSet, userTables } from './operations-shared';

export const HEALTH_ALLOTMENT: Allotment = { d1: 20, r2: 2, fetch: 0 };
export interface HealthLimits { listPage: number; orphanGraceMs: number }
export const HEALTH_LIMITS: HealthLimits = { listPage: 1000, orphanGraceMs: 3600_000 };
const HOUR = 3600_000, DAY = 24 * HOUR, SAMPLE = 20;
export const STALE_DEVICE_HOURS = 48, BACKLOG_SECONDS = 3600, CONTEXT_AGING_DAYS = 30;

type Tally = { count: number; sample: string[] };
export type Scan = { started_at: string; start_after: string | null; ticks: number; listed: number; bytes: number; batches: number;
  missing: Tally; orphans: Tally };
export type Pass = Scan & { completed_at: string };
const tally = (): Tally => ({ count: 0, sample: [] });
function add(target: Tally, id: string) { target.count++; if (target.sample.length < SAMPLE) target.sample.push(id); }

/**
 * One list-diff tick: list ≤ listPage keys under batches/ from the stored position and read
 * the same key range from the batches.r2_key index, then diff both ways.
 */
async function listDiff(env: Env, now: Date, limits: HealthLimits): Promise<Record<string, unknown>> {
  let state: { revision: number; scan: string | null; last_pass: string | null } | null;
  try { state = await env.DB.prepare('SELECT revision,scan,last_pass FROM health_state WHERE id=1').first(); }
  catch (error) {
    // Code deployed before migration 0006 was applied: report it rather than a generic failure.
    if (!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='health_state'").first()) state = null;
    else throw error;
  }
  if (!state) throw new MaintenanceError('health_schema_missing');
  const scan: Scan = state.scan ? JSON.parse(state.scan) : { started_at: iso(now), start_after: null, ticks: 0, listed: 0, bytes: 0, batches: 0,
    missing: tally(), orphans: tally() };
  const listing = await env.RAW.list({ prefix: 'batches/', limit: limits.listPage, ...(scan.start_after ? { startAfter: scan.start_after } : {}) });
  let objects = listing.objects, truncated = listing.truncated && objects.length > 0;
  // '0' sorts right after '/', so this bound covers every key under the prefix.
  let upper = truncated ? objects.at(-1)!.key : 'batches0';
  const rows = await env.DB.prepare('SELECT id,r2_key FROM batches WHERE r2_key>? AND r2_key<=? ORDER BY r2_key LIMIT ?')
    .bind(scan.start_after ?? 'batches/', upper, limits.listPage + 1).all<{ id: string; r2_key: string }>();
  let indexed = rows.results;
  if (indexed.length > limits.listPage) {
    // More index rows than one page: stop this tick at the last row read so both sides stay bounded.
    indexed = indexed.slice(0, limits.listPage); upper = indexed.at(-1)!.r2_key; truncated = true;
    objects = objects.filter(object => object.key <= upper);
  }
  const listed = new Set(objects.map(object => object.key)), keys = new Set(indexed.map(row => row.r2_key));
  for (const row of indexed) if (!listed.has(row.r2_key)) add(scan.missing, row.id);
  // Ingest writes R2 before its D1 commit, so young unindexed objects are usually in flight.
  for (const object of objects) if (!keys.has(object.key) && now.getTime() - object.uploaded.getTime() > limits.orphanGraceMs) add(scan.orphans, object.key);
  scan.ticks++; scan.listed += objects.length; scan.batches += indexed.length;
  scan.bytes += objects.reduce((sum, object) => sum + object.size, 0);
  scan.start_after = upper;
  const done = !truncated;
  const pass: Pass | null = done ? { ...scan, start_after: null, completed_at: iso(now) } : null;
  const update = await env.DB.prepare('UPDATE health_state SET scan=?,last_pass=COALESCE(?,last_pass),revision=revision+1,updated_at=? WHERE id=1 AND revision=?')
    .bind(done ? null : JSON.stringify(scan), pass ? JSON.stringify(pass) : null, iso(now), state.revision).run();
  // Overlapping invocations: the loser's tick is discarded rather than double counted.
  if (!update.meta.changes) return { conflict: true };
  return { listed: objects.length, indexed: indexed.length, pass_completed: done, missing: scan.missing.count, orphans: scan.orphans.count };
}

export function createHealthTask(overrides: Partial<HealthLimits> = {}): MaintenanceTask {
  const limits = { ...HEALTH_LIMITS, ...overrides };
  return { name: 'health', schedule: 'hourly', allotment: HEALTH_ALLOTMENT, run: (env, ctx) => listDiff(env, ctx.now, limits) };
}
export const healthTask = createHealthTask();

type Finding = { code: string; severity: 'critical' | 'warning' | 'info'; count: number; sample_ids: string[]; hint: string };
const HINTS: Record<string, [Finding['severity'], string]> = {
  raw_missing: ['critical', '中央索引指向的 R2 原文不存在。不要刪除索引；先從備份 raw/ 複本還原同一個 key，或請該裝置重送同一批次。'],
  backup_integrity_failed: ['critical', '備份完整性檢查發現物件缺失或雜湊不符。不要依此 checkpoint 刪除原文；重新執行備份並檢查 BACKUP bucket。'],
  backup_raw_source_missing: ['critical', '備份時找不到這些批次的 R2 原文，因此沒有備份複本。先處理原文缺失，再重新備份。'],
  device_stale: ['warning', `裝置超過 ${STALE_DEVICE_HOURS} 小時沒有上傳。確認該 Mac 是否開機、forwarder 是否仍在執行，或裝置金鑰是否已撤銷。`],
  ingest_backlog: ['warning', '最近上傳的事件比發生時間晚很多，代表該裝置有積壓或曾離線。檢查 forwarder 的 outbox 與網路；補送完成後會恢復。'],
  context_sources_invalid: ['warning', '已核准筆記的來源範圍已改變，不再是有效依據。請重新審閱原始來源，需要時建立新版本。'],
  open_flags: ['warning', '有尚未處理的筆記標記。請在「交接與記憶」查看並處理。'],
  processing_failed: ['warning', '背景整理工作失敗，需要審閱者重試或略過。'],
  processing_queue_stale: ['warning', '背景整理佇列有工作到期超過 6 小時仍未執行。確認 processing 排程已啟用且未超出預算。'],
  backup_stale: ['warning', '最近完成的備份已超過預期間隔。確認 backup 排程已啟用、BACKUP bucket 可寫入，並查看 checkpoint 錯誤碼。'],
  backup_failed: ['warning', '最近一次備份失敗。查看 checkpoint 錯誤碼；修正後可由審閱者重新啟動備份。'],
  backup_raw_lag: ['warning', '有超過 2 小時仍未複製到 BACKUP 的原文批次。確認 backup 排程持續執行。'],
  retention_raw_delete_pending: ['warning', '保存期限已刪除索引，但 R2 原文刪除尚未完成。backup 排程會重試；持續出現時檢查 RAW bucket 權限。'],
  resurrected_batch: ['warning', '保存期限刪除過的批次又被上傳回來（例如 forwarder 重送保留的本機紀錄）。確認是否要再次刪除，並檢查本機保留與重送設定。'],
  backup_unverified: ['info', '沒有 N 天內已通過還原演練及完整性檢查的備份，原文保存期限無法套用。完成還原演練後由審閱者記錄結果。'],
  backup_not_configured: ['info', '尚未綁定 BACKUP bucket，因此沒有排程備份，也不能套用原文保存期限。'],
  backup_not_scheduled: ['info', '已綁定 BACKUP bucket，但 MAINTENANCE_TASKS 沒有啟用 backup。'],
  raw_orphan: ['info', 'R2 有原文但沒有索引（上傳中斷或保存期限刪除未完成）。可由裝置重送同一批次補齊索引；不要直接刪除。'],
  raw_scan_stale: ['info', '7 天內沒有完成原文與索引的比對。啟用 health 排程後會逐步檢查。'],
  context_aging: ['info', `已核准筆記超過 ${CONTEXT_AGING_DAYS} 天，且所屬專案之後有新活動。請確認內容是否仍正確，需要時建立新版本。`],
};
function finding(code: string, count: number, sample: string[] = [], env?: Env): Finding {
  const [severity, hint] = HINTS[code];
  return { code, severity, count, sample_ids: sample.slice(0, SAMPLE),
    hint: code === 'backup_unverified' && env ? hint.replace('N', String(backupMaxAgeDays(env))) : hint };
}
const ids = (rows: D1Result) => (rows.results as { id: string }[]).map(row => row.id);
const rank = { critical: 0, warning: 1, info: 2 };

// Same rule as context views: a source event that left the note's project or task invalidates it.
const invalidSourceScope = `EXISTS(SELECT 1 FROM context_sources s JOIN events e ON e.id=s.event_id
  WHERE s.context_id=c.id AND (e.project_id!=c.project_id OR (c.task_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM task_sessions ts WHERE ts.task_id=c.task_id AND ts.session_id=e.session_id))))`;

/** Health report for the dashboard, the read API and the MCP tool. */
export async function dataHealth(env: Env, options: { now?: Date; exact?: boolean } = {}) {
  const now = options.now ?? new Date(), tables = await tableSet(env.DB), has = (name: string) => tables.has(name);
  const operations = has('backup_checkpoints') && has('health_state') && has('retention_run_objects');
  const rowTables = (await userTables(env.DB)).filter(table => table.rowid).map(table => table.name);
  const groups = Array.from({ length: Math.ceil(rowTables.length / 20) }, (_, index) => rowTables.slice(index * 20, index * 20 + 20));
  const statements = [
    env.DB.prepare('SELECT id,name,revoked,last_seen FROM devices ORDER BY name,id LIMIT 1000'),
    env.DB.prepare(`SELECT b.device_id,b.received_at,(SELECT MAX(e.timestamp) FROM events e WHERE e.batch_id=b.id) AS newest
      FROM batches b WHERE b.received_at>=? ORDER BY b.received_at DESC LIMIT 400`).bind(iso(now.getTime() - DAY)),
    env.DB.prepare(`SELECT c.id FROM context_entries c WHERE c.status='approved' AND ${invalidSourceScope} ORDER BY c.reviewed_at DESC,c.id LIMIT 1001`),
    env.DB.prepare(`SELECT c.id FROM context_entries c WHERE c.status='approved' AND c.reviewed_at<?
      AND EXISTS(SELECT 1 FROM events e WHERE e.project_id=c.project_id AND e.timestamp>c.reviewed_at) ORDER BY c.reviewed_at,c.id LIMIT 1001`)
      .bind(iso(now.getTime() - CONTEXT_AGING_DAYS * DAY)),
    // MAX(rowid) is O(1): capacity never scans a table on its own. D1 limits compound
    // SELECTs, so each statement is one row of scalar subqueries over up to 20 tables.
    ...groups.map(group => env.DB.prepare('SELECT ' + group.map((table, index) => `(SELECT MAX(rowid) FROM ${quoted(table)}) AS c${index}`).join(','))),
    ...(options.exact ? groups.map(group => env.DB.prepare('SELECT ' + group.map((table, index) => `(SELECT COUNT(*) FROM ${quoted(table)}) AS c${index}`).join(','))) : []),
  ];
  const offset = statements.length;
  if (operations) statements.push(
    env.DB.prepare('SELECT scan,last_pass FROM health_state WHERE id=1'),
    env.DB.prepare('SELECT * FROM backup_checkpoints ORDER BY started_at DESC,id DESC LIMIT 1'),
    env.DB.prepare(`SELECT id,completed_at,final_snapshot_at FROM backup_checkpoints WHERE status IN ('completed','verified')
      ORDER BY completed_at DESC,id DESC LIMIT 1`),
    env.DB.prepare(`SELECT id,final_snapshot_at,integrity_verified_at,verified_at FROM backup_checkpoints WHERE status='verified'
      AND integrity_verified_at IS NOT NULL AND raw_pruned_at IS NULL AND final_snapshot_at>=? ORDER BY final_snapshot_at DESC,id DESC LIMIT 1`)
      .bind(iso(now.getTime() - backupMaxAgeDays(env) * DAY)),
    env.DB.prepare("SELECT id FROM backup_checkpoints WHERE integrity_error IS NOT NULL AND status!='expired' ORDER BY started_at DESC LIMIT 1001"),
    env.DB.prepare("SELECT batch_id AS id FROM backup_raw_objects WHERE status='source_missing' ORDER BY batch_received_at LIMIT 1001"),
    env.DB.prepare('SELECT raw_cursor FROM backup_state WHERE id=1'),
    env.DB.prepare('SELECT r.batch_id AS id FROM retention_run_objects r JOIN batches b ON b.id=r.batch_id ORDER BY r.created_at LIMIT 1001'),
    env.DB.prepare('SELECT batch_id AS id FROM retention_run_objects WHERE raw_deleted_at IS NULL ORDER BY created_at LIMIT 1001'),
  );
  const results = await env.DB.batch(statements);
  const findings: Finding[] = [];
  const capped = (rows: D1Result) => { const list = ids(rows); return { count: list.length > 1000 ? 1000 : list.length, sample: list }; };

  // Devices: liveness and recent ingest lag (receipt minus newest event time per batch) as a backlog signal.
  const lags = new Map<string, number[]>();
  for (const row of results[1].results as { device_id: string; received_at: string; newest: string | null }[]) {
    if (!row.newest) continue;
    const list = lags.get(row.device_id) ?? []; list.push(Math.max(0, (Date.parse(row.received_at) - Date.parse(row.newest)) / 1000)); lags.set(row.device_id, list);
  }
  const devices = (results[0].results as { id: string; name: string; revoked: number; last_seen: string | null }[]).map(device => {
    const list = (lags.get(device.id) ?? []).sort((a, b) => a - b);
    return { id: device.id, name: device.name, revoked: !!device.revoked, last_seen: device.last_seen, recent_batches: list.length,
      lag_seconds: list.length ? { max: Math.round(list.at(-1)!), median: Math.round(list[Math.floor((list.length - 1) / 2)]) } : null };
  });
  const stale = devices.filter(device => !device.revoked && (!device.last_seen || now.getTime() - Date.parse(device.last_seen) > STALE_DEVICE_HOURS * HOUR));
  if (stale.length) findings.push(finding('device_stale', stale.length, stale.map(device => device.id)));
  const backlog = devices.filter(device => device.lag_seconds && device.lag_seconds.median > BACKLOG_SECONDS);
  if (backlog.length) findings.push(finding('ingest_backlog', backlog.length, backlog.map(device => device.id)));
  for (const [code, rows] of [['context_sources_invalid', results[2]], ['context_aging', results[3]]] as const) {
    const value = capped(rows); if (value.count) findings.push(finding(code, value.count, value.sample));
  }
  const tableValues = (start: number) => Object.fromEntries(groups.flatMap((group, index) => {
    const row = results[start + index].results[0] as Record<string, number | null>;
    return group.map((table, column) => [table, row[`c${column}`] ?? 0]);
  }));
  const capacity = { d1_size_bytes: results[4].meta.size_after ?? null, approx_rows: tableValues(4),
    ...(options.exact ? { exact_rows: tableValues(4 + groups.length) } : {}),
    raw_bytes: null as number | null, raw_bytes_measured_at: null as string | null };

  let raw: Record<string, unknown> = { scanned: false };
  let backup: Record<string, unknown> = { configured: !!env.BACKUP, scheduled: scheduledTask(env, 'backup'), available: operations };
  let retention: Record<string, unknown> = { available: operations };
  if (!env.BACKUP) findings.push(finding('backup_not_configured', 1));
  else if (!scheduledTask(env, 'backup')) findings.push(finding('backup_not_scheduled', 1));
  if (operations) {
    const state = results[offset].results[0] as { scan: string | null; last_pass: string | null } | undefined;
    const scan = state?.scan ? JSON.parse(state.scan) as Scan : null, pass = state?.last_pass ? JSON.parse(state.last_pass) as Pass : null;
    raw = { scheduled: scheduledTask(env, 'health'), in_progress: scan ? { started_at: scan.started_at, ticks: scan.ticks, listed: scan.listed,
      missing: scan.missing.count, orphans: scan.orphans.count } : null, last_pass: pass };
    if (pass) {
      capacity.raw_bytes = pass.bytes; capacity.raw_bytes_measured_at = pass.completed_at;
      if (pass.missing.count) findings.push(finding('raw_missing', pass.missing.count, pass.missing.sample));
      if (pass.orphans.count) findings.push(finding('raw_orphan', pass.orphans.count, pass.orphans.sample));
    }
    if (!pass || now.getTime() - Date.parse(pass.completed_at) > 7 * DAY) findings.push(finding('raw_scan_stale', 1));
    const latest = results[offset + 1].results[0] as { id: string; status: string; error_code: string | null; started_at: string } | undefined;
    const completed = results[offset + 2].results[0] as { id: string; completed_at: string; final_snapshot_at: string } | undefined;
    const ready = results[offset + 3].results[0] as Record<string, string> | undefined;
    const integrity = capped(results[offset + 4]), sourceMissing = capped(results[offset + 5]);
    const cursor = (results[offset + 6].results[0] as { raw_cursor: string | null } | undefined)?.raw_cursor;
    const parsed = cursor ? JSON.parse(cursor) as [string, string] : null;
    const lag = await env.DB.prepare(`SELECT COUNT(*) AS n,MIN(received_at) AS oldest FROM (SELECT received_at FROM batches WHERE received_at<?
      ${parsed ? 'AND (received_at,id)>(?,?)' : ''} LIMIT 10001)`)
      .bind(iso(now.getTime() - 2 * HOUR), ...(parsed ?? [])).first<{ n: number; oldest: string | null }>();
    backup = { ...backup, latest: latest ? { id: latest.id, status: latest.status, started_at: latest.started_at, error_code: latest.error_code } : null,
      latest_completed: completed ?? null, retention_ready: ready ?? null, raw_copy: { pending_over_2h: lag?.n ?? 0, oldest_pending_at: lag?.oldest ?? null } };
    if (env.BACKUP) {
      if (!completed || now.getTime() - Date.parse(completed.completed_at) > 2 * backupIntervalHours(env) * HOUR)
        findings.push(finding('backup_stale', 1, completed ? [completed.id] : []));
      if (latest?.status === 'failed') findings.push(finding('backup_failed', 1, [latest.id]));
      if (!ready) findings.push(finding('backup_unverified', 1, [], env));
      if (lag?.n) findings.push(finding('backup_raw_lag', lag.n > 10000 ? 10000 : lag.n));
    }
    if (integrity.count) findings.push(finding('backup_integrity_failed', integrity.count, integrity.sample));
    if (sourceMissing.count) findings.push(finding('backup_raw_source_missing', sourceMissing.count, sourceMissing.sample));
    const resurrected = capped(results[offset + 7]), pending = capped(results[offset + 8]);
    retention = { available: true, resurrected_batches: resurrected.count, raw_deletes_pending: pending.count };
    if (resurrected.count) findings.push(finding('resurrected_batch', resurrected.count, resurrected.sample));
    if (pending.count) findings.push(finding('retention_raw_delete_pending', pending.count, pending.sample));
  }

  // Tables from other tracks: looked up first, read in their own guarded query so a schema
  // difference reports `query_failed` instead of breaking the whole report.
  let processing: Record<string, unknown> = { available: false };
  if (has('processing_jobs')) {
    try {
      // created_at is the plan time and never changes; next_attempt_at is when a queued job became
      // claimable (plan, backoff, reviewer retry or requeue), so staleness is measured from it.
      const rows = await env.DB.prepare(`SELECT status,COUNT(*) AS n,MIN(created_at) AS oldest,MIN(next_attempt_at) AS due FROM processing_jobs
        WHERE status IN ('queued','running','failed') GROUP BY status`).all<{ status: string; n: number; oldest: string; due: string }>();
      const by = Object.fromEntries(rows.results.map(row => [row.status, row]));
      processing = { available: true, queued: by.queued?.n ?? 0, running: by.running?.n ?? 0, failed: by.failed?.n ?? 0,
        oldest_queued_at: by.queued?.oldest ?? null, oldest_due_at: by.queued?.due ?? null };
      if (by.failed?.n) findings.push(finding('processing_failed', by.failed.n));
      if (by.queued && now.getTime() - Date.parse(by.queued.due) > 6 * HOUR) findings.push(finding('processing_queue_stale', by.queued.n));
    } catch { processing = { available: true, error: 'query_failed' }; }
  }
  let flags: Record<string, unknown> = { available: false };
  if (has('context_flags')) {
    try {
      const open = await env.DB.prepare("SELECT id FROM context_flags WHERE status='open' ORDER BY created_at,id LIMIT 1001").all<{ id: string }>();
      flags = { available: true, open: Math.min(open.results.length, 1000) };
      if (open.results.length) findings.push(finding('open_flags', Math.min(open.results.length, 1000), open.results.map(row => row.id)));
    } catch { flags = { available: true, error: 'query_failed' }; }
  }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.code < b.code ? -1 : 1));
  return { generated_at: iso(now), findings, devices, raw, capacity, backup, retention, processing, flags,
    schema: { data_operations: operations, processing_jobs: has('processing_jobs'), context_flags: has('context_flags') } };
}

export async function healthRead(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.pathname !== '/api/health/data') return null;
  for (const key of url.searchParams.keys()) if (key !== 'exact' || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, 'Invalid health filter');
  const exact = url.searchParams.get('exact');
  if (exact !== null && !['0', '1'].includes(exact)) throw new HttpError(400, 'exact must be 0 or 1');
  return json(await dataHealth(env, { exact: exact === '1' }));
}
