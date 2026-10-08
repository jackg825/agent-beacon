// Explicit raw retention. Nothing is deleted on a schedule or on any model judgement:
// a reviewer applies a plan that names whole batches, the server re-checks every batch
// under the plan's own cutoff, and the D1 rows and R2 objects go only after a verified,
// integrity-checked backup holds them. See DATA-OPERATIONS.md.
import { z } from 'zod';
import { digest } from './auth';
import { rawCopyKey } from './backup';
import { stableJSON } from './identity';
import { Env, HttpError, json } from './types';
import { readJson } from './workflow';
import { HASH, SETTLE_MS, backupMaxAgeDays, hex, iso, retentionGraceDays, tableSet } from './operations-shared';

export const DATA_CLASSES = ['raw', 'summary', 'candidate', 'audit'] as const;
export type DataClass = typeof DATA_CLASSES[number];
/** Oldest batches considered by one plan; reports say when more exist. */
export const RETENTION_SCAN_LIMIT = 500;
export const MAX_PLAN_BATCHES = 50;
export const PLAN_TTL_MS = 3600_000;
const DAY = 86400_000;
const isoTime = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/).refine(value => Number.isFinite(Date.parse(value)));
const policySchema = z.object({ data_class: z.enum(DATA_CLASSES), keep_days: z.number().int().min(1).max(36500).nullable() }).strict();
const applySchema = z.object({
  data_class: z.literal('raw'), generated_at: isoTime, cutoff: isoTime,
  batch_ids: z.array(z.string().regex(HASH)).min(1).max(MAX_PLAN_BATCHES), plan_sha256: z.string().regex(HASH),
}).strict();
export type ApplyInput = z.infer<typeof applySchema>;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'Invalid retention request');
  return parsed.data;
}

export async function retentionPolicies(env: Env) {
  const rows = await env.DB.prepare('SELECT data_class,keep_days,updated_at,updated_by FROM retention_policies')
    .all<{ data_class: DataClass; keep_days: number | null; updated_at: string; updated_by: string }>();
  const stored = new Map(rows.results.map(row => [row.data_class, row]));
  // Summary, candidate and audit rows are immutable under the phase-1 triggers: their
  // periods are recorded for the workspace but cannot be enforced.
  return DATA_CLASSES.map(data_class => ({ data_class, keep_days: stored.get(data_class)?.keep_days ?? null, enforced: data_class === 'raw',
    updated_at: stored.get(data_class)?.updated_at ?? null, updated_by: stored.get(data_class)?.updated_by ?? null }));
}

async function setPolicy(request: Request, env: Env, actor: string) {
  const input = parse(policySchema, await readJson(request)), now = iso(new Date());
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO retention_policies(data_class,keep_days,updated_at,updated_by) VALUES(?,?,?,?)
      ON CONFLICT(data_class) DO UPDATE SET keep_days=excluded.keep_days,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .bind(input.data_class, input.keep_days, now, actor),
    env.DB.prepare('INSERT INTO retention_policy_audit(id,data_class,keep_days,actor,created_at) VALUES(?,?,?,?,?)')
      .bind(crypto.randomUUID(), input.data_class, input.keep_days, actor, now),
  ]);
  return json({ policies: await retentionPolicies(env) });
}

export function planHash(generatedAt: string, cutoff: string, batchIds: string[]): Promise<string> {
  return digest(stableJSON(['raw', generatedAt, cutoff, batchIds]));
}

type BatchRow = { id: string; r2_key: string; received_at: string };
type Gate = { id: string; final_snapshot_at: string };
type Assessment = {
  base: Map<string, Set<string>>; edges: { home: string; other: string }[]; gate: Gate | null; running: boolean;
  events: Map<string, number>; versions: Map<string, number>; backup: Map<string, { size: number; sha256: string }>; optional: Set<string>;
};
const inSet = 'SELECT value FROM json_each(?)';
/** Optional tables from other tracks whose references block deletion when they exist. */
function optionalReferences(tables: Set<string>) {
  const queries: { reason: string; sql: string }[] = [];
  if (tables.has('processing_jobs') && tables.has('processing_job_sources')) queries.push({ reason: 'referenced_by_processing',
    sql: `SELECT DISTINCT v.batch_id FROM processing_job_sources p JOIN processing_jobs j ON j.id=p.job_id
      JOIN event_versions v ON v.event_id=p.event_id AND v.payload_hash=p.payload_hash
      WHERE j.status IN ('queued','running','failed') AND v.batch_id IN (${inSet})` });
  if (tables.has('context_flags')) queries.push({ reason: 'referenced_by_flag',
    sql: `SELECT DISTINCT v.batch_id FROM context_flags f, json_each(f.evidence) j
      JOIN event_versions v ON v.event_id=json_extract(j.value,'$.event_id') AND v.payload_hash=json_extract(j.value,'$.payload_hash')
      WHERE f.status='open' AND v.batch_id IN (${inSet})` });
  return queries;
}

/** Everything eligibility needs, read in one D1 batch so it is one consistent view. */
async function assess(env: Env, batches: BatchRow[], now: Date): Promise<Assessment> {
  const ids = JSON.stringify(batches.map(batch => batch.id)), tables = await tableSet(env.DB);
  const optional = optionalReferences(tables);
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(`SELECT DISTINCT e.batch_id AS home,v.batch_id AS other FROM events e JOIN event_versions v ON v.event_id=e.id
        WHERE e.batch_id IN (${inSet}) AND v.batch_id!=e.batch_id`).bind(ids),
      env.DB.prepare(`SELECT DISTINCT v.batch_id FROM event_versions v JOIN context_sources s ON s.event_id=v.event_id AND s.payload_hash=v.payload_hash
        WHERE v.batch_id IN (${inSet})`).bind(ids),
      env.DB.prepare(`SELECT batch_id,size,sha256 FROM backup_raw_objects WHERE status='copied' AND batch_id IN (${inSet})`).bind(ids),
      env.DB.prepare(`SELECT batch_id,COUNT(*) AS n FROM events WHERE batch_id IN (${inSet}) GROUP BY batch_id`).bind(ids),
      env.DB.prepare(`SELECT batch_id,COUNT(*) AS n FROM event_versions WHERE batch_id IN (${inSet}) GROUP BY batch_id`).bind(ids),
      env.DB.prepare(`SELECT id,final_snapshot_at FROM backup_checkpoints WHERE status='verified' AND integrity_verified_at IS NOT NULL
        AND raw_pruned_at IS NULL AND final_snapshot_at>=? ORDER BY final_snapshot_at DESC,id DESC LIMIT 1`)
        .bind(iso(now.getTime() - backupMaxAgeDays(env) * DAY)),
      env.DB.prepare("SELECT id FROM backup_checkpoints WHERE status='running' LIMIT 1"),
      ...optional.map(query => env.DB.prepare(query.sql).bind(ids)),
    ]);
  } catch {
    // Fail closed: an unreadable reference table must never look like "no references".
    throw new HttpError(503, 'Retention reference check unavailable');
  }
  const base = new Map(batches.map(batch => [batch.id, new Set<string>()]));
  const mark = (rows: D1Result, reason: string) => { for (const row of rows.results as { batch_id: string }[]) base.get(row.batch_id)?.add(reason); };
  mark(results[1], 'referenced_by_context');
  optional.forEach((query, index) => mark(results[7 + index], query.reason));
  const counts = (rows: D1Result) => new Map((rows.results as { batch_id: string; n: number }[]).map(row => [row.batch_id, row.n]));
  const backup = new Map((results[2].results as { batch_id: string; size: number; sha256: string }[]).map(row => [row.batch_id, row]));
  const gate = (results[5].results[0] as Gate | undefined) ?? null;
  // A batch is covered only if its copy is tracked and it settled before the verified snapshot ran.
  const covered = gate ? Date.parse(gate.final_snapshot_at) - SETTLE_MS : -Infinity;
  for (const batch of batches) if (!gate || !backup.has(batch.id) || Date.parse(batch.received_at) > covered) base.get(batch.id)!.add('no_verified_backup');
  return { base, edges: results[0].results as { home: string; other: string }[], gate, running: results[6].results.length > 0,
    events: counts(results[3]), versions: counts(results[4]), backup, optional: new Set(optional.map(query => query.reason)) };
}

/**
 * Batches in `ids` that cannot be deleted together. An event's row lives in its first batch,
 * so a batch whose events have versions in a batch outside the set (or a blocked one) is blocked too.
 */
export function blockedWithin(ids: Set<string>, base: Map<string, Set<string>>, edges: { home: string; other: string }[]) {
  const blocked = new Set([...ids].filter(id => base.get(id)?.size));
  for (let changed = true; changed;) {
    changed = false;
    for (const { home, other } of edges) {
      if (ids.has(home) && !blocked.has(home) && (!ids.has(other) || blocked.has(other))) { blocked.add(home); changed = true; }
    }
  }
  return blocked;
}
function reasonsFor(id: string, ids: Set<string>, blocked: Set<string>, assessment: Assessment): string[] {
  const reasons = new Set(assessment.base.get(id));
  if (assessment.edges.some(edge => edge.home === id && (!ids.has(edge.other) || blocked.has(edge.other)))) reasons.add('shared_event_versions');
  return [...reasons].sort();
}

export async function retentionPlan(env: Env, options: { now?: Date; maxBatches?: number } = {}) {
  const now = options.now ?? new Date(), maxBatches = options.maxBatches ?? MAX_PLAN_BATCHES;
  const policies = await retentionPolicies(env), raw = policies[0];
  const reportOnly = policies.slice(1).map(policy => ({ data_class: policy.data_class, keep_days: policy.keep_days, enforced: false,
    blocked: [{ reason: 'class_report_only', count: null }] }));
  const empty = { batches: 0, events: 0, versions: 0, bytes: 0 };
  if (raw.keep_days === null) return { generated_at: iso(now), policies, classes: [{ data_class: 'raw', keep_days: null, enforced: true,
    cutoff: null, scanned: 0, scan_limited: false, eligible: empty, blocked: [{ reason: 'within_keep_days', count: null }] }, ...reportOnly],
    backup_checkpoint: null, plan: null };
  const cutoff = iso(now.getTime() - raw.keep_days * DAY);
  const [candidates, newer] = await env.DB.batch([
    env.DB.prepare('SELECT id,r2_key,received_at FROM batches WHERE received_at<? ORDER BY received_at,id LIMIT ?').bind(cutoff, RETENTION_SCAN_LIMIT + 1),
    env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM batches WHERE received_at>=? LIMIT 10001)').bind(cutoff),
  ]);
  const scanned = (candidates.results as BatchRow[]).slice(0, RETENTION_SCAN_LIMIT);
  const assessment = await assess(env, scanned, now), ids = new Set(scanned.map(batch => batch.id));
  const blocked = blockedWithin(ids, assessment.base, assessment.edges);
  const eligible = scanned.filter(batch => !blocked.has(batch.id));
  // The plan itself must be closed: take each eligible batch together with the batches its
  // events' versions live in, skip a group that does not fit, then drop anything still open.
  const depends = new Map<string, string[]>(), eligibleIds = new Set(eligible.map(batch => batch.id)), selected = new Set<string>();
  for (const { home, other } of assessment.edges) depends.set(home, [...depends.get(home) ?? [], other]);
  for (const batch of eligible) {
    if (selected.size >= maxBatches) break;
    const group = new Set<string>(), stack = [batch.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (group.has(id) || selected.has(id)) continue;
      group.add(id); stack.push(...depends.get(id) ?? []);
    }
    if ([...group].every(id => eligibleIds.has(id)) && selected.size + group.size <= maxBatches) for (const id of group) selected.add(id);
  }
  for (let inner = blockedWithin(selected, assessment.base, assessment.edges); inner.size; inner = blockedWithin(selected, assessment.base, assessment.edges))
    for (const id of inner) selected.delete(id);
  const batchIds = scanned.filter(batch => selected.has(batch.id)).map(batch => batch.id);
  const reasonCounts = new Map<string, number>();
  for (const id of blocked) for (const reason of reasonsFor(id, ids, blocked, assessment)) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  const newerCount = (newer.results[0] as { n: number }).n;
  const total = (list: string[]) => ({ batches: list.length, events: list.reduce((sum, id) => sum + (assessment.events.get(id) ?? 0), 0),
    versions: list.reduce((sum, id) => sum + (assessment.versions.get(id) ?? 0), 0),
    bytes: list.reduce((sum, id) => sum + (assessment.backup.get(id)?.size ?? 0), 0) });
  const generatedAt = iso(now);
  return { generated_at: generatedAt, policies, classes: [{ data_class: 'raw', keep_days: raw.keep_days, enforced: true, cutoff,
    scanned: scanned.length, scan_limited: candidates.results.length > RETENTION_SCAN_LIMIT, eligible: total(eligible.map(batch => batch.id)),
    blocked: [...[...reasonCounts].sort(([a], [b]) => a < b ? -1 : 1).map(([reason, count]) => ({ reason, count })),
      { reason: 'within_keep_days', count: newerCount > 10000 ? null : newerCount, ...(newerCount > 10000 ? { at_least: 10001 } : {}) }],
    blocked_batches: [...blocked].slice(0, 20).map(id => ({ batch_id: id, reasons: reasonsFor(id, ids, blocked, assessment) })) }, ...reportOnly],
    backup_checkpoint: assessment.gate, backup_running: assessment.running, reference_checks: [...assessment.optional].sort(),
    plan: batchIds.length ? { data_class: 'raw' as const, generated_at: generatedAt, cutoff, batch_ids: batchIds,
      plan_sha256: await planHash(generatedAt, cutoff, batchIds), ...total(batchIds) } : null };
}

/** Re-check the exact plan, confirm every BACKUP copy, then delete D1 rows and only then RAW objects. */
export async function applyRetention(env: Env, input: ApplyInput, actor: string, now = new Date()) {
  const ids = input.batch_ids, set = new Set(ids);
  if (set.size !== ids.length) throw new HttpError(400, 'Duplicate batch ids');
  if (await planHash(input.generated_at, input.cutoff, ids) !== input.plan_sha256) throw new HttpError(409, 'Retention plan hash does not match');
  const generated = Date.parse(input.generated_at);
  if (now.getTime() - generated > PLAN_TTL_MS || generated > now.getTime() + 60_000) throw new HttpError(409, 'Retention plan expired; generate a new plan');
  const raw = (await retentionPolicies(env))[0];
  if (raw.keep_days === null) throw new HttpError(409, 'Raw retention is not configured');
  if (Date.parse(input.cutoff) > now.getTime() - raw.keep_days * DAY) throw new HttpError(409, 'Retention policy changed; generate a new plan');
  if (!env.BACKUP) throw new HttpError(409, 'Backup bucket not configured');
  const rows = await env.DB.prepare(`SELECT id,r2_key,received_at FROM batches WHERE id IN (${inSet})`).bind(JSON.stringify(ids)).all<BatchRow>();
  if (rows.results.length !== ids.length) throw new HttpError(409, 'A planned batch no longer exists');
  const batches = ids.map(id => rows.results.find(row => row.id === id)!);
  if (batches.some(batch => batch.received_at >= input.cutoff)) throw new HttpError(409, 'A planned batch is newer than the plan cutoff');
  const assessment = await assess(env, batches, now);
  if (assessment.running) throw new HttpError(409, 'A backup checkpoint is running; apply after it completes');
  const blocked = blockedWithin(set, assessment.base, assessment.edges);
  if (blocked.size) return json({ error: 'Retention plan is no longer eligible; generate a new plan',
    blocked: [...blocked].map(id => ({ batch_id: id, reasons: reasonsFor(id, set, blocked, assessment) })) }, 409);
  // The primary copy goes only while the BACKUP copy still exists with the recorded size and checksum.
  for (const batch of batches) {
    const head = await env.BACKUP.head(rawCopyKey(batch.r2_key)), expected = assessment.backup.get(batch.id)!;
    const stored = head ? hex(head.checksums.sha256) : null;
    if (!head || head.size !== expected.size || (stored !== null && stored !== expected.sha256))
      return json({ error: 'Backup copy missing or changed; retention refused', batch_id: batch.id }, 409);
  }
  const runId = crypto.randomUUID(), at = iso(now), keys = batches.map(batch => batch.r2_key).sort();
  const objects = batches.map(batch => ({ batch_id: batch.id, r2_key: batch.r2_key, size: assessment.backup.get(batch.id)!.size }));
  const totals = { events: ids.reduce((sum, id) => sum + (assessment.events.get(id) ?? 0), 0),
    versions: ids.reduce((sum, id) => sum + (assessment.versions.get(id) ?? 0), 0), bytes: objects.reduce((sum, object) => sum + object.size, 0) };
  const idJson = JSON.stringify(ids), args: unknown[] = [];
  const guard = (sql: string, ...values: unknown[]) => { args.push(...values); return sql; };
  // Re-assert every eligibility rule inside the deleting transaction; a concurrent change makes the run row (and so every delete) a no-op.
  const conditions = [
    guard("NOT EXISTS(SELECT 1 FROM backup_checkpoints WHERE status='running')"),
    guard(`EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=? AND status='verified' AND integrity_verified_at IS NOT NULL AND raw_pruned_at IS NULL)`, assessment.gate!.id),
    guard(`(SELECT COUNT(*) FROM batches WHERE id IN (${inSet}))=?`, idJson, ids.length),
    guard(`NOT EXISTS(SELECT 1 FROM event_versions v JOIN context_sources s ON s.event_id=v.event_id AND s.payload_hash=v.payload_hash
      WHERE v.batch_id IN (${inSet}))`, idJson),
    guard(`NOT EXISTS(SELECT 1 FROM events e JOIN event_versions v ON v.event_id=e.id WHERE e.batch_id IN (${inSet})
      AND v.batch_id NOT IN (${inSet}))`, idJson, idJson),
    ...optionalReferences(await tableSet(env.DB)).map(query => guard(`NOT EXISTS(${query.sql})`, idJson)),
  ];
  const run = 'EXISTS(SELECT 1 FROM retention_runs WHERE id=?)';
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO retention_runs(id,data_class,plan_sha256,generated_at,cutoff,batch_count,event_count,version_count,raw_bytes,
        keys_sha256,checkpoint_id,actor,created_at) SELECT ?,'raw',?,?,?,?,?,?,?,?,?,?,? WHERE ${conditions.join(' AND ')}`)
        .bind(runId, input.plan_sha256, input.generated_at, input.cutoff, ids.length, totals.events, totals.versions, totals.bytes,
          await digest(keys.join('\n')), assessment.gate!.id, actor, at, ...args),
      env.DB.prepare(`INSERT INTO retention_run_objects(run_id,batch_id,r2_key,size,created_at,backup_delete_after)
        SELECT ?,json_extract(value,'$.batch_id'),json_extract(value,'$.r2_key'),json_extract(value,'$.size'),?,? FROM json_each(?) WHERE ${run}`)
        .bind(runId, at, iso(now.getTime() + retentionGraceDays(env) * DAY), JSON.stringify(objects), runId),
      env.DB.prepare(`DELETE FROM event_versions WHERE batch_id IN (${inSet}) AND ${run}`).bind(idJson, runId),
      env.DB.prepare(`DELETE FROM events WHERE batch_id IN (${inSet}) AND ${run}`).bind(idJson, runId),
      env.DB.prepare(`DELETE FROM batches WHERE id IN (${inSet}) AND ${run}`).bind(idJson, runId),
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) throw new HttpError(409, 'Retention plan already applied');
    if (/FOREIGN KEY/i.test(String(error))) throw new HttpError(409, 'Retention plan conflicts with new references; generate a new plan');
    throw error;
  }
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'Retention plan conflicts with current data; generate a new plan');
  // D1 rows are gone; a failed RAW delete leaves a tracked object the backup task retries.
  let rawDeleted = false;
  try {
    await env.RAW.delete(keys);
    await env.DB.prepare('UPDATE retention_run_objects SET raw_deleted_at=? WHERE run_id=? AND raw_deleted_at IS NULL').bind(at, runId).run();
    rawDeleted = true;
  } catch { /* Retried by the backup task; reported by data health. */ }
  return json({ run: { id: runId, data_class: 'raw', plan_sha256: input.plan_sha256, cutoff: input.cutoff, batch_count: ids.length,
    event_count: totals.events, version_count: totals.versions, raw_bytes: totals.bytes, checkpoint_id: assessment.gate!.id, created_at: at,
    backup_delete_after: iso(now.getTime() + retentionGraceDays(env) * DAY) }, raw_deleted: rawDeleted }, 201);
}

export async function retentionRead(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.pathname === '/api/retention/policies') {
    if (url.search) throw new HttpError(400, 'Retention policies do not accept filters');
    return json({ policies: await retentionPolicies(env) });
  }
  if (url.pathname === '/api/retention/plan') {
    const params = url.searchParams;
    for (const key of params.keys()) if (key !== 'max_batches' || params.getAll(key).length !== 1) throw new HttpError(400, 'Invalid retention filter');
    const raw = params.get('max_batches');
    if (raw !== null && (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_PLAN_BATCHES)) throw new HttpError(400, 'max_batches must be 1–50');
    return json(await retentionPlan(env, { maxBatches: raw === null ? MAX_PLAN_BATCHES : Number(raw) }));
  }
  return null;
}

export async function retentionWrite(request: Request, env: Env, actor: string): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const url = new URL(request.url);
  if (!['/api/retention/policies', '/api/retention/apply'].includes(url.pathname)) return null;
  if (url.search) throw new HttpError(400, 'Retention writes do not accept filters');
  if (url.pathname === '/api/retention/policies') return setPolicy(request, env, actor);
  return applyRetention(env, parse(applySchema, await readJson(request)), actor);
}

/** Exported for tests and the dashboard contract. */
export const parseApply = (value: unknown) => parse(applySchema, value);
