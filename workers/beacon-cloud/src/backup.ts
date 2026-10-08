// Scheduled backups into the optional private BACKUP bucket. Nothing runs unless the
// operator binds BACKUP and names `backup` in MAINTENANCE_TASKS. Every cursor advance is a
// compare-and-swap, every object key is derived from identifiers, and reports carry only
// identifiers, counts, hashes and codes. See DATA-OPERATIONS.md.
import { z } from 'zod';
import { digest } from './auth';
import { MaintenanceError } from './maintenance-error';
import type { Allotment, MaintenanceContext, MaintenanceTask } from './maintenance';
import { pageLimit } from './queries';
import { Env, HttpError, json } from './types';
import { readJson } from './workflow';
import { BACKUP_BOOKKEEPING, CHUNKED_TABLES, HASH, RAW_KEY, SETTLE_MS, UUID, backupIntervalHours, decodeCursor,
  encodeCursor, hex, iso, jsonChunks, quoted, retentionGraceDays, room, scheduledTask, userTables } from './operations-shared';

export const BACKUP_ALLOTMENT: Allotment = { d1: 300, r2: 2500, fetch: 0 };
export interface BackupLimits {
  /** Platform calls per tick; every step checks it before starting so a tick ends cleanly. */
  allotment: Allotment;
  /** Batches per chunk round; a smaller remainder waits for the final snapshot. */
  chunkBatches: number;
  /** Most batches the final snapshot may carry as its tail. */
  tailBatches: number;
  finalMaxRows: number;
  finalMaxBytes: number;
  /** Largest single final-snapshot object. */
  objectMaxBytes: number;
  rawListPage: number;
  rawCopyPerTick: number;
  pruneBatch: number;
  /** R2 reads/heads the integrity pass may spend per tick. */
  integrityPerTick: number;
  /** Checkpoint steps per tick (tests use 1 to stop between steps). */
  maxSteps: number;
  leaseMs: number;
  settleMs: number;
}
export const BACKUP_LIMITS: BackupLimits = {
  allotment: BACKUP_ALLOTMENT, chunkBatches: 100, tailBatches: 200, finalMaxRows: 60_000, finalMaxBytes: 24 * 1024 * 1024, objectMaxBytes: 4 * 1024 * 1024,
  rawListPage: 5000, rawCopyPerTick: 500, pruneBatch: 200, integrityPerTick: 1500, maxSteps: 1000, leaseMs: 20 * 60_000,
  settleMs: SETTLE_MS,
};

export type Checkpoint = {
  id: string; status: string; phase: string; started_at: string; started_by: string; cursor: string | null; chunk_count: number;
  final_snapshot_at: string | null; batches_through: string | null; raw_listed_at: string | null; raw_object_count: number;
  raw_bytes: number; completed_at: string | null; manifest_key: string | null; manifest_sha256: string | null;
  table_counts: string | null; integrity_cursor: string | null; integrity_verified_at: string | null; integrity_error: string | null;
  verified_at: string | null; verified_by: string | null; verification_result: string | null; verification_sha256: string | null;
  raw_pruned_at: string | null; expired_at: string | null; expired_by: string | null; expire_cursor: number | null;
  objects_deleted_at: string | null; error_code: string | null; lease_owner: string | null; lease_until: string | null; updated_at: string;
};
type Stop = 'budget' | 'wait';
type Row = Record<string, unknown>;

/** A deterministic checkpoint failure; transient platform errors propagate and retry next tick. */
class BackupFailure extends Error { constructor(public code: string) { super(code); } }
const encoder = new TextEncoder();
const pad = (value: number) => String(value).padStart(6, '0');
export const chunkKey = (id: string, kind: 'd1' | 'raw', seq: number) => `checkpoints/${id}/${kind}/${pad(seq)}.ndjson`;
export const manifestKey = (id: string) => `checkpoints/${id}/manifest.json`;
export const rawCopyKey = (r2Key: string) => 'raw/' + r2Key;
const latest = (a: string | null, b: string | null) => !a ? b : !b ? a : a > b ? a : b;
/** Keyset position after a cursor; the row-value form walks the (time,id) index without sorting the remaining range. */
function after(cursor: [string, string] | null, time = 'received_at', id = 'id') {
  return cursor ? { sql: `(${time},${id})>(?,?)`, args: [cursor[0], cursor[1]] } : { sql: '1=1', args: [] as unknown[] };
}
function parsePair(value: string | null): [string, string] | null { return value ? JSON.parse(value) as [string, string] : null; }
async function put(bucket: R2Bucket, key: string, body: Uint8Array) {
  const sha256 = await digest(body);
  // R2 recomputes the SHA-256 and rejects the write if the bytes differ in transit.
  await bucket.put(key, body, { sha256, httpMetadata: { contentType: key.endsWith('.json') ? 'application/json' : 'application/x-ndjson' } });
  return sha256;
}
function ndjson(lines: string[]): Uint8Array { return encoder.encode(lines.length ? lines.join('\n') + '\n' : ''); }
function line(table: string, row: Row): string {
  for (const value of Object.values(row)) {
    if (value !== null && typeof value === 'object') throw new BackupFailure('unsupported_column_value');
  }
  return JSON.stringify({ t: table, r: row });
}

// ---- raw copies -----------------------------------------------------------------

/** Copy settled raw batches not yet tracked in backup_raw_objects (2 R2 calls each). */
async function copyRaw(env: Env, ctx: MaintenanceContext, limits: BackupLimits, result: Row) {
  if (!room(ctx, limits.allotment, { d1: 6, r2: 2 })) return;
  const [stateResult, runningResult] = await env.DB.batch([
    env.DB.prepare('SELECT raw_cursor,revision FROM backup_state WHERE id=1'),
    env.DB.prepare("SELECT id FROM backup_checkpoints WHERE status='running' LIMIT 1"),
  ]);
  const state = stateResult.results[0] as { raw_cursor: string | null; revision: number } | undefined;
  if (!state) throw new MaintenanceError('backup_schema_missing');
  const running = (runningResult.results[0] as { id: string } | undefined)?.id ?? null;
  const reserve = Math.min(300, Math.floor(limits.allotment.r2 / 4)), affordable = Math.floor((limits.allotment.r2 - ctx.usage().r2 - reserve) / 2);
  const limit = Math.min(limits.rawCopyPerTick, affordable);
  if (limit <= 0) return;
  const range = after(parsePair(state.raw_cursor));
  const rows = await env.DB.prepare(`SELECT id,r2_key,received_at FROM batches WHERE received_at<? AND ${range.sql}
    ORDER BY received_at,id LIMIT ?`).bind(iso(ctx.now.getTime() - limits.settleMs), ...range.args, limit)
    .all<{ id: string; r2_key: string; received_at: string }>();
  const copies: Row[] = [];
  let missing = 0;
  for (const row of rows.results) {
    if (!room(ctx, limits.allotment, { d1: 5, r2: 2 })) break;
    const object = await env.RAW.get(row.r2_key);
    const base = { batch_id: row.id, r2_key: row.r2_key, batch_received_at: row.received_at, first_checkpoint_id: running };
    if (!object) { missing++; copies.push({ ...base, status: 'source_missing', size: null, sha256: null }); continue; }
    const bytes = new Uint8Array(await object.arrayBuffer());
    copies.push({ ...base, status: 'copied', size: bytes.byteLength, sha256: await put(env.BACKUP!, rawCopyKey(row.r2_key), bytes) });
  }
  if (!copies.length) return;
  const now = iso(ctx.now), last = copies.at(-1)!;
  const statements = jsonChunks(copies).map(chunk => env.DB.prepare(`INSERT INTO backup_raw_objects(batch_id,r2_key,batch_received_at,status,size,sha256,copied_at,first_checkpoint_id)
    SELECT json_extract(value,'$.batch_id'),json_extract(value,'$.r2_key'),json_extract(value,'$.batch_received_at'),json_extract(value,'$.status'),
    json_extract(value,'$.size'),json_extract(value,'$.sha256'),?,json_extract(value,'$.first_checkpoint_id') FROM json_each(?) WHERE true
    ON CONFLICT(batch_id) DO UPDATE SET status=excluded.status,size=excluded.size,sha256=excluded.sha256,batch_received_at=excluded.batch_received_at,
    copied_at=excluded.copied_at,deleted_at=NULL WHERE excluded.status='copied' AND (backup_raw_objects.status!='copied'
    OR EXISTS(SELECT 1 FROM retention_run_objects r WHERE r.batch_id=excluded.batch_id AND r.created_at>=backup_raw_objects.copied_at))`).bind(now, chunk));
  statements.push(env.DB.prepare('UPDATE backup_state SET raw_cursor=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?')
    .bind(JSON.stringify([last.batch_received_at, last.batch_id]), now, state.revision));
  const results = await env.DB.batch(statements);
  // Copies are idempotent; a lost cursor race only means another invocation got further. A batch a
  // forwarder replay brought back after retention (or whose source reappeared) is recorded as copied again.
  result.raw_copied = copies.length - missing;
  result.raw_source_missing = missing;
  if (results.at(-1)!.meta.changes !== 1) result.raw_cursor_conflict = true;
}

// ---- retention follow-up ----------------------------------------------------------

/** Retry RAW deletes that failed during retention apply and drop BACKUP copies after the grace period. */
async function pruneRetained(env: Env, ctx: MaintenanceContext, limits: BackupLimits, result: Row) {
  const now = iso(ctx.now);
  // A batch that a forwarder replay brought back is live again; leave its objects alone.
  const live = 'NOT EXISTS(SELECT 1 FROM batches b WHERE b.id=r.batch_id)';
  if (room(ctx, limits.allotment, { d1: 2, r2: 1 })) {
    const pending = await env.DB.prepare(`SELECT r.run_id,r.batch_id,r.r2_key FROM retention_run_objects r
      WHERE r.raw_deleted_at IS NULL AND ${live} ORDER BY r.created_at,r.run_id,r.batch_id LIMIT ?`).bind(limits.pruneBatch)
      .all<{ run_id: string; batch_id: string; r2_key: string }>();
    if (pending.results.length) {
      await env.RAW.delete(pending.results.map(row => row.r2_key));
      await env.DB.prepare(`UPDATE retention_run_objects SET raw_deleted_at=? WHERE raw_deleted_at IS NULL
        AND run_id||'/'||batch_id IN (SELECT value FROM json_each(?))`)
        .bind(now, JSON.stringify(pending.results.map(row => row.run_id + '/' + row.batch_id))).run();
      result.raw_deletes_retried = pending.results.length;
    }
  }
  if (room(ctx, limits.allotment, { d1: 4, r2: 1 })) {
    const due = await env.DB.prepare(`SELECT r.run_id,r.batch_id,r.r2_key,r.created_at FROM retention_run_objects r
      WHERE r.backup_deleted_at IS NULL AND r.backup_delete_after<=? AND ${live} ORDER BY r.backup_delete_after,r.run_id,r.batch_id LIMIT ?`)
      .bind(now, limits.pruneBatch).all<{ run_id: string; batch_id: string; r2_key: string; created_at: string }>();
    if (due.results.length) {
      await env.BACKUP!.delete(due.results.map(row => rawCopyKey(row.r2_key)));
      const pairs = JSON.stringify(due.results.map(row => row.run_id + '/' + row.batch_id));
      const newest = due.results.reduce((value, row) => row.created_at > value ? row.created_at : value, '');
      await env.DB.batch([
        env.DB.prepare(`UPDATE retention_run_objects SET backup_deleted_at=? WHERE backup_deleted_at IS NULL
          AND run_id||'/'||batch_id IN (SELECT value FROM json_each(?))`).bind(now, pairs),
        env.DB.prepare(`UPDATE backup_raw_objects SET status='deleted',deleted_at=? WHERE status!='deleted'
          AND batch_id IN (SELECT value FROM json_each(?))`).bind(now, JSON.stringify(due.results.map(row => row.batch_id))),
        // Checkpoints started before the run listed these copies; they can no longer restore those rows' raw lines.
        env.DB.prepare(`UPDATE backup_checkpoints SET raw_pruned_at=?,updated_at=? WHERE raw_pruned_at IS NULL AND status!='expired'
          AND started_at<=?`).bind(now, now, newest),
      ]);
      result.backup_copies_deleted = due.results.length;
    }
  }
}

// ---- checkpoint state machine -----------------------------------------------------

async function ensureCheckpoint(env: Env, ctx: MaintenanceContext): Promise<Checkpoint | null> {
  const running = await env.DB.prepare("SELECT * FROM backup_checkpoints WHERE status='running' LIMIT 1").first<Checkpoint>();
  if (running) return running;
  const previous = await env.DB.prepare('SELECT started_at FROM backup_checkpoints ORDER BY started_at DESC,id DESC LIMIT 1')
    .first<{ started_at: string }>();
  if (previous && ctx.now.getTime() - Date.parse(previous.started_at) < backupIntervalHours(env) * 3600_000) return null;
  const id = crypto.randomUUID(), now = iso(ctx.now), actor = 'maintenance:backup';
  const [created] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO backup_checkpoints(id,status,phase,started_at,started_by,updated_at)
      SELECT ?,'running','chunks',?,?,? WHERE NOT EXISTS(SELECT 1 FROM backup_checkpoints WHERE status='running')
      ON CONFLICT DO NOTHING RETURNING *`).bind(id, now, actor, now),
    env.DB.prepare(`INSERT INTO backup_audit(id,checkpoint_id,actor,action,created_at)
      SELECT ?,?,?,'run',? WHERE EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=?)`).bind(crypto.randomUUID(), id, actor, now, id),
  ]);
  return (created.results[0] as Checkpoint | undefined) ?? null;
}

/** Full chunk rounds export settled batches with their events and versions; the remainder goes to the final snapshot. */
async function chunkStep(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string): Promise<Checkpoint | Stop> {
  if (!room(ctx, limits.allotment, { d1: 6, r2: 1 })) return 'budget';
  const range = after(parsePair(cp.cursor));
  const pick = `SELECT id FROM batches WHERE received_at<? AND ${range.sql} ORDER BY received_at,id LIMIT ?`;
  const args = [iso(ctx.now.getTime() - limits.settleMs), ...range.args, limits.chunkBatches];
  // One D1 batch is one transaction, so a batch row always travels with its own events and versions.
  const [batches, events, versions] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM batches WHERE id IN (${pick}) ORDER BY received_at,id`).bind(...args),
    env.DB.prepare(`SELECT * FROM events WHERE batch_id IN (${pick}) ORDER BY batch_id,rowid`).bind(...args),
    env.DB.prepare(`SELECT * FROM event_versions WHERE batch_id IN (${pick}) ORDER BY batch_id,rowid`).bind(...args),
  ]);
  const rows = { batches: batches.results as Row[], events: events.results as Row[], event_versions: versions.results as Row[] };
  if (rows.batches.length < limits.chunkBatches) return finalStep(env, ctx, cp, limits, owner, rows);
  return writeRowsChunk(env, ctx, cp, owner, rows);
}

async function writeRowsChunk(env: Env, ctx: MaintenanceContext, cp: Checkpoint, owner: string,
  rows: { batches: Row[]; events: Row[]; event_versions: Row[] }): Promise<Checkpoint> {
  const lines = CHUNKED_TABLES.flatMap(table => rows[table].map(row => line(table, row)));
  const body = ndjson(lines), seq = cp.chunk_count + 1, key = chunkKey(cp.id, 'd1', seq), now = iso(ctx.now);
  const sha256 = await put(env.BACKUP!, key, body);
  const last = rows.batches.at(-1)!;
  const counts = Object.fromEntries(CHUNKED_TABLES.map(table => [table, rows[table].length]));
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE backup_checkpoints SET cursor=?,chunk_count=?,batches_through=?,updated_at=?
      WHERE id=? AND status='running' AND phase='chunks' AND lease_owner=? AND chunk_count=? RETURNING *`)
      .bind(JSON.stringify([last.received_at, last.id]), seq, latest(cp.batches_through, String(last.received_at)), now, cp.id, owner, cp.chunk_count),
    env.DB.prepare(`INSERT INTO backup_chunks(checkpoint_id,seq,kind,key,sha256,bytes,rows,created_at)
      SELECT ?,?,'rows',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=? AND chunk_count=? AND lease_owner=?)`)
      .bind(cp.id, seq, key, sha256, body.byteLength, JSON.stringify(counts), now, cp.id, seq, owner),
  ]);
  const next = updated.results[0] as Checkpoint | undefined;
  if (!next) throw new MaintenanceError('backup_cas_conflict');
  return next;
}

/**
 * Every non-chunked table plus the chunk tail, read in ONE D1 batch (one transaction), so
 * the checkpoint is foreign-key closed. Only events.project_id can drift between an earlier
 * chunk and this snapshot; restore-check reports that as a finding.
 */
async function finalStep(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string,
  settled: { batches: Row[]; events: Row[]; event_versions: Row[] }): Promise<Checkpoint | Stop> {
  const tables = (await userTables(env.DB)).filter(table => !(CHUNKED_TABLES as readonly string[]).includes(table.name)
    && !BACKUP_BOOKKEEPING.has(table.name));
  const maxObjects = Math.ceil(limits.finalMaxBytes / limits.objectMaxBytes) + 1;
  if (!room(ctx, limits.allotment, { d1: tables.length + 6, r2: maxObjects })) return 'budget';
  const range = after(parsePair(cp.cursor));
  const tail = `SELECT id FROM batches WHERE ${range.sql} ORDER BY received_at,id LIMIT ?`;
  const args = [...range.args, limits.tailBatches + 1];
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM batches WHERE id IN (${tail}) ORDER BY received_at,id`).bind(...args),
    env.DB.prepare(`SELECT * FROM events WHERE batch_id IN (${tail}) ORDER BY batch_id,rowid`).bind(...args),
    env.DB.prepare(`SELECT * FROM event_versions WHERE batch_id IN (${tail}) ORDER BY batch_id,rowid`).bind(...args),
    ...tables.map(table => env.DB.prepare(`SELECT * FROM ${quoted(table.name)} ${table.rowid ? 'ORDER BY rowid' : ''} LIMIT ?`)
      .bind(limits.finalMaxRows + 1)),
  ]);
  const tailBatches = results[0].results as Row[];
  if (tailBatches.length > limits.tailBatches) {
    // Too much recent ingest to carry in one transaction: export what has settled and retry later.
    return settled.batches.length ? writeRowsChunk(env, ctx, cp, owner, settled) : 'wait';
  }
  const snapshot: [string, Row[]][] = [['batches', tailBatches], ['events', results[1].results as Row[]],
    ['event_versions', results[2].results as Row[]], ...tables.map((table, index) => [table.name, results[index + 3].results as Row[]] as [string, Row[]])];
  let total = 0;
  for (const [, rows] of snapshot) { total += rows.length; if (rows.length > limits.finalMaxRows || total > limits.finalMaxRows) throw new BackupFailure('final_snapshot_too_large'); }
  // Split into bounded objects; the first object's row counts name every snapshot table, including empty ones.
  const objects: { lines: string[]; bytes: number; rows: Record<string, number> }[] = [{ lines: [], bytes: 0, rows: Object.fromEntries(snapshot.map(([name]) => [name, 0])) }];
  let size = 0;
  for (const [table, rows] of snapshot) for (const row of rows) {
    const text = line(table, row), bytes = encoder.encode(text).byteLength + 1;
    size += bytes;
    if (size > limits.finalMaxBytes) throw new BackupFailure('final_snapshot_too_large');
    let current = objects.at(-1)!;
    if (current.lines.length && current.bytes + bytes > limits.objectMaxBytes) { current = { lines: [], bytes: 0, rows: {} }; objects.push(current); }
    current.lines.push(text); current.bytes += bytes; current.rows[table] = (current.rows[table] ?? 0) + 1;
  }
  const now = iso(ctx.now), chunks: Row[] = [];
  let seq = cp.chunk_count;
  for (const object of objects) {
    seq++;
    const key = chunkKey(cp.id, 'd1', seq), body = ndjson(object.lines);
    chunks.push({ seq, key, sha256: await put(env.BACKUP!, key, body), bytes: body.byteLength, rows: JSON.stringify(object.rows) });
  }
  const through = tailBatches.reduce<string | null>((value, row) => latest(value, String(row.received_at)), cp.batches_through);
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE backup_checkpoints SET phase='raw',cursor=NULL,chunk_count=?,final_snapshot_at=?,batches_through=?,updated_at=?
      WHERE id=? AND status='running' AND phase='chunks' AND lease_owner=? AND chunk_count=? RETURNING *`)
      .bind(seq, now, through, now, cp.id, owner, cp.chunk_count),
    env.DB.prepare(`INSERT INTO backup_chunks(checkpoint_id,seq,kind,key,sha256,bytes,rows,created_at)
      SELECT ?,json_extract(value,'$.seq'),'final',json_extract(value,'$.key'),json_extract(value,'$.sha256'),json_extract(value,'$.bytes'),
      json_extract(value,'$.rows'),? FROM json_each(?) WHERE EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=? AND phase='raw' AND chunk_count=? AND lease_owner=?)`)
      .bind(cp.id, now, JSON.stringify(chunks), cp.id, seq, owner),
  ]);
  const next = updated.results[0] as Checkpoint | undefined;
  if (!next) throw new MaintenanceError('backup_cas_conflict');
  return next;
}

/**
 * Raw copies a checkpoint lists (binds: batches_through, raw_listed_at, started_at). Retention apply is
 * refused while a checkpoint runs, so a copy is left out exactly when a run before the checkpoint deleted
 * its batch after the copy was made; a replayed batch is copied again and so listed again.
 */
const RAW_LISTED = `o.status='copied' AND o.batch_received_at<=? AND o.copied_at<=?
  AND NOT EXISTS(SELECT 1 FROM retention_run_objects r WHERE r.batch_id=o.batch_id AND r.created_at<? AND r.created_at>=o.copied_at)`;

/** List the raw copies the checkpoint covers, once raw copying has caught up with every exported batch. */
async function rawListStep(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string): Promise<Checkpoint | Stop> {
  if (!room(ctx, limits.allotment, { d1: 5, r2: 1 })) return 'budget';
  if (cp.batches_through) {
    const state = await env.DB.prepare('SELECT raw_cursor FROM backup_state WHERE id=1').first<{ raw_cursor: string | null }>();
    const behind = after(parsePair(state?.raw_cursor ?? null));
    const pending = await env.DB.prepare(`SELECT 1 AS pending FROM batches WHERE received_at<=? AND ${behind.sql} LIMIT 1`)
      .bind(cp.batches_through, ...behind.args).first();
    if (pending) return 'wait';
  }
  const listedAt = cp.raw_listed_at ?? iso(ctx.now), range = after(parsePair(cp.cursor), 'o.batch_received_at', 'o.batch_id');
  const page = await env.DB.prepare(`SELECT o.batch_id,o.r2_key,o.size,o.sha256,o.batch_received_at FROM backup_raw_objects o
    WHERE ${RAW_LISTED} AND ${range.sql} ORDER BY o.batch_received_at,o.batch_id LIMIT ?`)
    .bind(cp.batches_through ?? '', listedAt, cp.started_at, ...range.args, limits.rawListPage)
    .all<{ batch_id: string; r2_key: string; size: number; sha256: string; batch_received_at: string }>();
  const entries = page.results, done = entries.length < limits.rawListPage, now = iso(ctx.now);
  let seq = cp.chunk_count, chunk: Row | null = null;
  if (entries.length) {
    seq++;
    const key = chunkKey(cp.id, 'raw', seq);
    const body = ndjson(entries.map(entry => JSON.stringify({ batch_id: entry.batch_id, key: rawCopyKey(entry.r2_key), size: entry.size, sha256: entry.sha256 })));
    chunk = { seq, key, sha256: await put(env.BACKUP!, key, body), bytes: body.byteLength, rows: JSON.stringify({ raw_objects: entries.length }) };
  }
  const last = entries.at(-1);
  const statements = [env.DB.prepare(`UPDATE backup_checkpoints SET phase=?,cursor=?,chunk_count=?,raw_listed_at=?,
    raw_object_count=raw_object_count+?,raw_bytes=raw_bytes+?,updated_at=?
    WHERE id=? AND status='running' AND phase='raw' AND lease_owner=? AND chunk_count=? AND cursor IS ? RETURNING *`)
    .bind(done ? 'manifest' : 'raw', done || !last ? null : JSON.stringify([last.batch_received_at, last.batch_id]), seq, listedAt,
      entries.length, entries.reduce((sum, entry) => sum + entry.size, 0), now, cp.id, owner, cp.chunk_count, cp.cursor)];
  if (chunk) statements.push(env.DB.prepare(`INSERT INTO backup_chunks(checkpoint_id,seq,kind,key,sha256,bytes,rows,created_at)
    SELECT ?,?,'raw_list',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=? AND chunk_count=? AND lease_owner=?)`)
    .bind(cp.id, chunk.seq, chunk.key, chunk.sha256, chunk.bytes, chunk.rows, now, cp.id, seq, owner));
  const [updated] = await env.DB.batch(statements);
  const next = updated.results[0] as Checkpoint | undefined;
  if (!next) throw new MaintenanceError('backup_cas_conflict');
  return next;
}

export type Manifest = {
  format: 'beacon.backup.v1'; checkpoint_id: string; started_at: string; final_snapshot_at: string; batches_through: string | null;
  raw_listed_at: string; consistency: string; chunked_tables: string[]; excluded_tables: string[]; migrations: string[];
  table_counts: Record<string, number>; chunks: { seq: number; kind: 'rows' | 'final' | 'raw_list'; key: string; sha256: string; bytes: number;
    rows: Record<string, number> }[]; raw: { prefix: 'raw/'; objects: number; bytes: number };
};

async function manifestStep(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string): Promise<Checkpoint | Stop> {
  if (!room(ctx, limits.allotment, { d1: 3, r2: 1 })) return 'budget';
  const [chunkRows, ledger] = await env.DB.batch([
    env.DB.prepare('SELECT seq,kind,key,sha256,bytes,rows FROM backup_chunks WHERE checkpoint_id=? ORDER BY seq').bind(cp.id),
    env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'"),
  ]);
  const migrations = ledger.results.length
    ? (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map(row => row.name) : [];
  const chunks = (chunkRows.results as { seq: number; kind: 'rows' | 'final' | 'raw_list'; key: string; sha256: string; bytes: number; rows: string }[])
    .map(chunk => ({ ...chunk, rows: JSON.parse(chunk.rows) as Record<string, number> }));
  const counts: Record<string, number> = {};
  for (const chunk of chunks) if (chunk.kind !== 'raw_list') for (const [table, count] of Object.entries(chunk.rows)) counts[table] = (counts[table] ?? 0) + count;
  const tableCounts = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : 1));
  const manifest: Manifest = { format: 'beacon.backup.v1', checkpoint_id: cp.id, started_at: cp.started_at, final_snapshot_at: cp.final_snapshot_at!,
    batches_through: cp.batches_through, raw_listed_at: cp.raw_listed_at!, consistency: 'chunked_rows_then_final_snapshot',
    chunked_tables: [...CHUNKED_TABLES], excluded_tables: [...BACKUP_BOOKKEEPING].sort(), migrations, table_counts: tableCounts, chunks,
    raw: { prefix: 'raw/', objects: cp.raw_object_count, bytes: cp.raw_bytes } };
  const body = encoder.encode(JSON.stringify(manifest)), key = manifestKey(cp.id), now = iso(ctx.now);
  const sha256 = await put(env.BACKUP!, key, body);
  const updated = await env.DB.prepare(`UPDATE backup_checkpoints SET status='completed',phase='done',manifest_key=?,manifest_sha256=?,
    table_counts=?,completed_at=?,lease_owner=NULL,lease_until=NULL,updated_at=?
    WHERE id=? AND status='running' AND phase='manifest' AND lease_owner=? RETURNING *`)
    .bind(key, sha256, JSON.stringify(tableCounts), now, now, cp.id, owner).first<Checkpoint>();
  if (!updated) throw new MaintenanceError('backup_cas_conflict');
  return updated;
}

async function advanceCheckpoint(env: Env, ctx: MaintenanceContext, limits: BackupLimits, result: Row) {
  if (!room(ctx, limits.allotment, { d1: 8, r2: 1 })) return;
  const found = await ensureCheckpoint(env, ctx);
  if (!found) return;
  const owner = crypto.randomUUID(), now = iso(ctx.now);
  let cp = await env.DB.prepare(`UPDATE backup_checkpoints SET lease_owner=?,lease_until=?,updated_at=?
    WHERE id=? AND status='running' AND (lease_until IS NULL OR lease_until<=?) RETURNING *`)
    .bind(owner, iso(ctx.now.getTime() + limits.leaseMs), now, found.id, now).first<Checkpoint>();
  if (!cp) { result.checkpoint = { id: found.id, leased_elsewhere: true }; return; }
  let steps = 0, stop: Stop | null = null;
  try {
    while (cp.status === 'running' && steps < limits.maxSteps) {
      const next: Checkpoint | Stop = cp.phase === 'chunks' ? await chunkStep(env, ctx, cp, limits, owner)
        : cp.phase === 'raw' ? await rawListStep(env, ctx, cp, limits, owner) : await manifestStep(env, ctx, cp, limits, owner);
      if (typeof next === 'string') { stop = next; break; }
      cp = next; steps++;
    }
  } catch (error) {
    if (!(error instanceof BackupFailure)) {
      await env.DB.prepare('UPDATE backup_checkpoints SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?').bind(cp.id, owner).run().catch(() => {});
      throw error;
    }
    await env.DB.prepare(`UPDATE backup_checkpoints SET status='failed',error_code=?,lease_owner=NULL,lease_until=NULL,updated_at=?
      WHERE id=? AND status='running' AND lease_owner=?`).bind(error.code, iso(ctx.now), cp.id, owner).run();
    result.checkpoint = { id: cp.id, status: 'failed', error: error.code, steps };
    return;
  }
  if (cp.status === 'running') await env.DB.prepare('UPDATE backup_checkpoints SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?')
    .bind(cp.id, owner).run();
  result.checkpoint = { id: cp.id, status: cp.status, phase: cp.phase, steps, ...(stop ? { stopped: stop } : {}) };
}

// ---- integrity pass ------------------------------------------------------------------

type IntegrityCursor = { stage: 'manifest' } | { stage: 'chunks'; seq: number } | { stage: 'raw'; seq: number; index: number };

/** Re-hash every manifest-listed object in BACKUP (raw copies by size and stored SHA-256), bounded per tick. */
async function checkIntegrity(env: Env, ctx: MaintenanceContext, limits: BackupLimits, result: Row) {
  if (!room(ctx, limits.allotment, { d1: 4, r2: 1 })) return;
  const cp = await env.DB.prepare(`SELECT * FROM backup_checkpoints WHERE status IN ('completed','verified')
    AND integrity_verified_at IS NULL AND integrity_error IS NULL ORDER BY completed_at,id LIMIT 1`).first<Checkpoint>();
  if (!cp) return;
  let cursor: IntegrityCursor = cp.integrity_cursor ? JSON.parse(cp.integrity_cursor) : { stage: 'manifest' };
  let spent = 0, failure: string | null = null, done = false;
  const affordable = () => spent < limits.integrityPerTick && room(ctx, limits.allotment, { d1: 3, r2: 1 });
  const fetchBytes = async (key: string) => { spent++; const object = await env.BACKUP!.get(key); return object ? new Uint8Array(await object.arrayBuffer()) : null; };
  outer: while (!failure && !done && affordable()) {
    if (cursor.stage === 'manifest') {
      const bytes = await fetchBytes(cp.manifest_key!);
      if (!bytes) { failure = 'manifest_missing'; break; }
      if (await digest(bytes) !== cp.manifest_sha256) { failure = 'manifest_mismatch'; break; }
      cursor = { stage: 'chunks', seq: 0 };
    } else if (cursor.stage === 'chunks') {
      const chunks = await env.DB.prepare('SELECT seq,key,sha256,bytes FROM backup_chunks WHERE checkpoint_id=? AND seq>? ORDER BY seq LIMIT 50')
        .bind(cp.id, cursor.seq).all<{ seq: number; key: string; sha256: string; bytes: number }>();
      if (!chunks.results.length) { cursor = { stage: 'raw', seq: 0, index: 0 }; continue; }
      for (const chunk of chunks.results) {
        if (!affordable()) break outer;
        const bytes = await fetchBytes(chunk.key);
        if (!bytes) { failure = 'chunk_missing'; break outer; }
        if (bytes.byteLength !== chunk.bytes || await digest(bytes) !== chunk.sha256) { failure = 'chunk_mismatch'; break outer; }
        cursor = { stage: 'chunks', seq: chunk.seq };
      }
    } else {
      const chunk = await env.DB.prepare(`SELECT seq,key,sha256 FROM backup_chunks WHERE checkpoint_id=? AND kind='raw_list' AND seq>=?
        ORDER BY seq LIMIT 1`).bind(cp.id, cursor.seq).first<{ seq: number; key: string; sha256: string }>();
      if (!chunk) { done = true; break; }
      const bytes = await fetchBytes(chunk.key);
      if (!bytes || await digest(bytes) !== chunk.sha256) { failure = 'chunk_mismatch'; break; }
      const entries = new TextDecoder().decode(bytes).split('\n').filter(Boolean).map(text => JSON.parse(text) as { key: string; size: number; sha256: string });
      let index = cursor.seq === chunk.seq ? cursor.index : 0;
      for (; index < entries.length; index++) {
        if (!affordable()) { cursor = { stage: 'raw', seq: chunk.seq, index }; break outer; }
        spent++;
        const head = await env.BACKUP!.head(entries[index].key);
        if (!head) { failure = 'raw_missing'; break outer; }
        if (head.size !== entries[index].size || hex(head.checksums.sha256) !== entries[index].sha256) { failure = 'raw_mismatch'; break outer; }
      }
      cursor = { stage: 'raw', seq: chunk.seq + 1, index: 0 };
    }
  }
  const now = iso(ctx.now);
  const update = await env.DB.prepare(`UPDATE backup_checkpoints SET integrity_cursor=?,integrity_verified_at=?,integrity_error=?,updated_at=?
    WHERE id=? AND integrity_cursor IS ? AND integrity_verified_at IS NULL AND integrity_error IS NULL`)
    .bind(JSON.stringify(cursor), done ? now : null, failure, now, cp.id, cp.integrity_cursor).run();
  result.integrity = { id: cp.id, checked: spent, ...(done ? { verified: true } : {}), ...(failure ? { error: failure } : {}),
    ...(update.meta.changes ? {} : { conflict: true }) };
}

/** Build the backup task; tests pass smaller limits to exercise multi-tick behavior. */
export function createBackupTask(overrides: Partial<BackupLimits> = {}): MaintenanceTask {
  const limits = { ...BACKUP_LIMITS, ...overrides };
  return {
    name: 'backup', schedule: 'hourly', allotment: limits.allotment,
    async run(env, ctx) {
      if (!env.BACKUP) throw new MaintenanceError('backup_not_configured');
      const result: Row = {};
      await pruneRetained(env, ctx, limits, result);
      await copyRaw(env, ctx, limits, result);
      await advanceCheckpoint(env, ctx, limits, result);
      await checkIntegrity(env, ctx, limits, result);
      return result;
    },
  };
}
export const backupTask = createBackupTask();

// ---- reviewer routes -----------------------------------------------------------------

export function checkpointView(row: Checkpoint) {
  const { lease_owner, lease_until, cursor, integrity_cursor, table_counts, expire_cursor, ...rest } = row;
  return { ...rest, table_counts: table_counts ? JSON.parse(table_counts) as Record<string, number> : null,
    leased: !!lease_owner, retention_ready: row.status === 'verified' && !!row.integrity_verified_at && !row.raw_pruned_at };
}
async function checkpoint(env: Env, id: string): Promise<Checkpoint> {
  if (!UUID.test(id)) throw new HttpError(400, 'Invalid checkpoint id');
  const row = await env.DB.prepare('SELECT * FROM backup_checkpoints WHERE id=?').bind(id).first<Checkpoint>();
  if (!row) throw new HttpError(404, 'Checkpoint not found');
  return row;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'Invalid backup request');
  return parsed.data;
}
const verifySchema = z.object({
  result: z.enum(['passed', 'failed']), report_sha256: z.string().regex(HASH),
  counts: z.object({ tables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.number().int().min(0)),
    raw_objects: z.number().int().min(0) }).strict(),
}).strict();
const expireSchema = z.object({ reason: z.string().min(1).max(2000).optional() }).strict();

/** Membership of an object key in one checkpoint, decided from D1 records with fixed key shapes. */
async function isMember(env: Env, cp: Checkpoint, key: string): Promise<boolean> {
  if (key === manifestKey(cp.id)) return cp.manifest_key === key;
  if (new RegExp(`^checkpoints/${cp.id}/(?:d1|raw)/\\d{6}\\.ndjson$`).test(key))
    return !!await env.DB.prepare('SELECT 1 AS member FROM backup_chunks WHERE checkpoint_id=? AND key=?').bind(cp.id, key).first();
  if (key.startsWith('raw/') && RAW_KEY.test(key.slice(4))) {
    if (!cp.raw_listed_at || !cp.batches_through) return false;
    return !!await env.DB.prepare(`SELECT 1 AS member FROM backup_raw_objects o WHERE o.r2_key=? AND ${RAW_LISTED}`)
      .bind(key.slice(4), cp.batches_through, cp.raw_listed_at, cp.started_at).first();
  }
  throw new HttpError(400, 'Invalid backup object key');
}

/** Backups hold device token digests: the router sends these GETs through review authority. */
export async function backupsReviewerRead(request: Request, env: Env, _actor: string): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url), path = url.pathname, params = url.searchParams;
  if (path === '/api/backups') {
    for (const key of params.keys()) if (!['before', 'limit'].includes(key)) throw new HttpError(400, 'Invalid backup filter');
    const limit = pageLimit(params), before = decodeCursor(params.get('before'), UUID);
    const rows = await env.DB.prepare(`SELECT * FROM backup_checkpoints ${before ? 'WHERE (started_at<? OR (started_at=? AND id<?))' : ''}
      ORDER BY started_at DESC,id DESC LIMIT ?`).bind(...(before ? [before[0], before[0], before[1]] : []), limit + 1).all<Checkpoint>();
    const items = rows.results.slice(0, limit), last = items.at(-1);
    return json({ configured: !!env.BACKUP, scheduled: scheduledTask(env, 'backup'), checkpoints: items.map(checkpointView),
      next_cursor: rows.results.length > limit && last ? encodeCursor(last.started_at, last.id) : null });
  }
  const objectMatch = /^\/api\/backups\/([^/]+)\/object$/.exec(path);
  if (objectMatch) {
    const keys = params.getAll('key');
    if (keys.length !== 1 || [...params.keys()].some(key => key !== 'key') || keys[0].length > 512) throw new HttpError(400, 'Exactly one key required');
    const cp = await checkpoint(env, objectMatch[1]);
    if (!await isMember(env, cp, keys[0]) || !env.BACKUP) throw new HttpError(404, 'Backup object not found');
    const object = await env.BACKUP.get(keys[0]);
    if (!object) throw new HttpError(404, 'Backup object not found');
    return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size),
      'Content-Disposition': 'attachment; filename="beacon-backup-object"' } });
  }
  const detailMatch = /^\/api\/backups\/([^/]+)$/.exec(path);
  if (detailMatch) {
    if (url.search) throw new HttpError(400, 'Backup detail does not accept filters');
    const cp = await checkpoint(env, detailMatch[1]);
    const [chunks, audit] = await env.DB.batch([
      env.DB.prepare('SELECT kind,COUNT(*) AS count,SUM(bytes) AS bytes FROM backup_chunks WHERE checkpoint_id=? GROUP BY kind ORDER BY kind').bind(cp.id),
      env.DB.prepare('SELECT id,actor,action,detail,created_at FROM backup_audit WHERE checkpoint_id=? ORDER BY created_at,id LIMIT 100').bind(cp.id),
    ]);
    return json({ checkpoint: { ...checkpointView(cp), chunks: chunks.results,
      audit: (audit.results as { detail: string | null }[]).map(row => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null })) } });
  }
  return null;
}

async function runNow(env: Env, actor: string) {
  if (!env.BACKUP) throw new HttpError(409, 'Backup bucket not configured');
  const id = crypto.randomUUID(), now = iso(new Date());
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO backup_checkpoints(id,status,phase,started_at,started_by,updated_at)
        SELECT ?,'running','chunks',?,?,? WHERE NOT EXISTS(SELECT 1 FROM backup_checkpoints WHERE status='running')`).bind(id, now, actor, now),
      env.DB.prepare(`INSERT INTO backup_audit(id,checkpoint_id,actor,action,created_at)
        SELECT ?,?,?,'run',? WHERE EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=?)`).bind(crypto.randomUUID(), id, actor, now, id),
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) throw new HttpError(409, 'A backup checkpoint is already running');
    throw error;
  }
  if (!results[0].meta.changes) throw new HttpError(409, 'A backup checkpoint is already running');
  // Execution happens in the hourly maintenance task, never inside this request.
  return json({ checkpoint: checkpointView(await checkpoint(env, id)), scheduled: scheduledTask(env, 'backup') }, 202);
}

async function verify(request: Request, env: Env, id: string, actor: string) {
  const input = parse(verifySchema, await readJson(request));
  const cp = await checkpoint(env, id);
  if (cp.status === 'verified') throw new HttpError(409, 'Checkpoint already verified');
  if (cp.status !== 'completed') throw new HttpError(409, 'Only a completed checkpoint can record a restore drill');
  if (input.result === 'passed') {
    // The drill report is a reviewer attestation; the server can only check it against the manifest counts.
    const expected = JSON.parse(cp.table_counts!) as Record<string, number>;
    const names = Object.keys(expected);
    if (names.length !== Object.keys(input.counts.tables).length || names.some(name => input.counts.tables[name] !== expected[name])
      || input.counts.raw_objects !== cp.raw_object_count) throw new HttpError(409, 'Drill counts do not match the manifest');
  }
  const now = iso(new Date());
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE backup_checkpoints SET status=CASE WHEN ?='passed' THEN 'verified' ELSE status END,verified_at=?,verified_by=?,
      verification_result=?,verification_sha256=?,updated_at=? WHERE id=? AND status='completed'`)
      .bind(input.result, now, actor, input.result, input.report_sha256, now, id),
    env.DB.prepare(`INSERT INTO backup_audit(id,checkpoint_id,actor,action,detail,created_at)
      SELECT ?,?,?,'verify',?,? WHERE EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=? AND verified_at=? AND verified_by=?)`)
      .bind(crypto.randomUUID(), id, actor, JSON.stringify({ result: input.result, report_sha256: input.report_sha256 }), now, id, now, actor),
  ]);
  if (!updated.meta.changes) throw new HttpError(409, 'Checkpoint changed; reload it');
  return json({ checkpoint: checkpointView(await checkpoint(env, id)) });
}

/** Mark a checkpoint expired and delete its D1 export objects in bounded rounds; raw copies are shared and stay. */
async function expire(request: Request, env: Env, id: string, actor: string, now = new Date()) {
  const input = parse(expireSchema, await readJson(request));
  let cp = await checkpoint(env, id);
  if (cp.status !== 'expired') {
    const newest = await env.DB.prepare("SELECT id FROM backup_checkpoints WHERE status='verified' ORDER BY final_snapshot_at DESC,id DESC LIMIT 1")
      .first<{ id: string }>();
    if (newest?.id === id) throw new HttpError(409, 'The newest verified checkpoint must be kept');
    const relied = await env.DB.prepare('SELECT id FROM retention_runs WHERE checkpoint_id=? AND created_at>? LIMIT 1')
      .bind(id, iso(now.getTime() - retentionGraceDays(env) * 86400_000)).first();
    if (relied) throw new HttpError(409, 'A retention run within the grace period relied on this checkpoint');
    const at = iso(now);
    await env.DB.batch([
      env.DB.prepare(`UPDATE backup_checkpoints SET status='expired',expired_at=?,expired_by=?,expire_cursor=0,lease_owner=NULL,lease_until=NULL,
        updated_at=? WHERE id=? AND status!='expired'`).bind(at, actor, at, id),
      env.DB.prepare(`INSERT INTO backup_audit(id,checkpoint_id,actor,action,detail,created_at)
        SELECT ?,?,?,'expire',?,? WHERE EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=? AND expired_at=? AND expired_by=?)`)
        .bind(crypto.randomUUID(), id, actor, JSON.stringify({ reason_length: input.reason?.length ?? 0 }), at, id, at, actor),
    ]);
    cp = await checkpoint(env, id);
  }
  let deleted = !!cp.objects_deleted_at;
  if (!deleted && env.BACKUP) {
    let position = cp.expire_cursor ?? 0;
    for (let round = 0; round < 10 && !deleted; round++) {
      const keys = await env.DB.prepare('SELECT seq,key FROM backup_chunks WHERE checkpoint_id=? AND seq>? ORDER BY seq LIMIT 1000')
        .bind(id, position).all<{ seq: number; key: string }>();
      if (!keys.results.length) {
        if (cp.manifest_key) await env.BACKUP.delete(cp.manifest_key);
        await env.DB.prepare('UPDATE backup_checkpoints SET objects_deleted_at=?,updated_at=? WHERE id=? AND objects_deleted_at IS NULL')
          .bind(iso(now), iso(now), id).run();
        deleted = true;
        break;
      }
      await env.BACKUP.delete(keys.results.map(row => row.key));
      position = keys.results.at(-1)!.seq;
      await env.DB.prepare('UPDATE backup_checkpoints SET expire_cursor=? WHERE id=? AND expire_cursor<?').bind(position, id, position).run();
    }
  }
  return json({ checkpoint: checkpointView(await checkpoint(env, id)), objects_deleted: deleted });
}

export async function backupsWrite(request: Request, env: Env, actor: string): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/backups')) return null;
  if (url.search) throw new HttpError(400, 'Backup writes do not accept filters');
  if (path === '/api/backups/run') { parse(z.object({}).strict(), await readJson(request)); return runNow(env, actor); }
  const match = /^\/api\/backups\/([^/]+)\/(verify|expire)$/.exec(path);
  if (!match) return null;
  return match[2] === 'verify' ? verify(request, env, match[1], actor) : expire(request, env, match[1], actor);
}

/** Exposed for tests that drive expiry with an explicit clock. */
export const expireCheckpoint = expire;
