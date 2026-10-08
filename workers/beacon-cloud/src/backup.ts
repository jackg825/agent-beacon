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
import { BACKUP_BOOKKEEPING, BATCH_TABLES, HASH, LEDGER_TABLES, RAW_KEY, REVISED_TABLES, SETTLE_MS, UUID, backupIntervalHours, decodeCursor,
  encodeCursor, hex, iso, jsonChunks, quoted, retentionGraceDays, room, scheduledTask, tableSet, userTables } from './operations-shared';

export const BACKUP_ALLOTMENT: Allotment = { d1: 300, r2: 2500, fetch: 0 };
export interface BackupLimits {
  /** Platform calls per tick; every step checks it before starting so a tick ends cleanly. */
  allotment: Allotment;
  /** Batches per batch round. */
  chunkBatches: number;
  /** Most batches the final snapshot may carry as its tail. */
  tailBatches: number;
  /** Rows per ledger or revised-table round (a table may set a smaller page). */
  tablePageRows: number;
  /** Most rows of one round table the final snapshot may carry as its tail; more sends the table back for a round. */
  tailRows: number;
  /** Most rows of one revised table the final snapshot may re-read. */
  revisionMaxRows: number;
  /** How long before a revised table's first round a change still counts as possibly after it (writer clock lag). */
  revisionMarginMs: number;
  /** Rows the final snapshot may read in total, counting every statement's upper bound. */
  finalMaxRows: number;
  finalMaxBytes: number;
  /** Largest single final-snapshot object. */
  objectMaxBytes: number;
  rawListPage: number;
  rawCopyPerTick: number;
  /** Raw sources recorded as missing that one tick looks for again. */
  missingRetryPerTick: number;
  pruneBatch: number;
  /** R2 reads/heads the integrity pass may spend per tick. */
  integrityPerTick: number;
  /**
   * Share of the tick's allotment and remaining time the integrity pass may use before the
   * running checkpoint advances, so chunking can never starve it; it may use the rest afterwards.
   */
  integrityShare: number;
  /** Checkpoint steps per tick (tests use 1 to stop between steps). */
  maxSteps: number;
  leaseMs: number;
  settleMs: number;
}
export const BACKUP_LIMITS: BackupLimits = {
  allotment: BACKUP_ALLOTMENT, chunkBatches: 100, tailBatches: 200, tablePageRows: 1000, tailRows: 1000, revisionMaxRows: 10_000,
  revisionMarginMs: 3600_000, finalMaxRows: 60_000, finalMaxBytes: 24 * 1024 * 1024, objectMaxBytes: 4 * 1024 * 1024,
  rawListPage: 5000, rawCopyPerTick: 500, missingRetryPerTick: 50, pruneBatch: 200, integrityPerTick: 1500, integrityShare: 0.4, maxSteps: 1000,
  leaseMs: 20 * 60_000,
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
/** One exported row; a revision replaces the row with the same primary key that an earlier round exported. */
function line(table: string, row: Row, revision = false): string {
  for (const value of Object.values(row)) {
    if (value !== null && typeof value === 'object') throw new BackupFailure('unsupported_column_value');
  }
  return JSON.stringify(revision ? { t: table, r: row, revision: true } : { t: table, r: row });
}

// ---- raw copies -----------------------------------------------------------------

type Copy = { batch_id: string; r2_key: string; batch_received_at: string; first_checkpoint_id: string | null; status: 'copied' | 'source_missing';
  size: number | null; sha256: string | null };

/**
 * Statements that record copies. A row is rewritten when the copy is new, when its source was
 * missing before, or when a forwarder replay brought a retention-deleted batch back and it was
 * copied again; in that last case the earlier copy's listing attributes go to
 * backup_raw_generations first, so checkpoints that listed it keep their membership.
 */
function recordCopies(env: Env, copies: Copy[], now: string): D1PreparedStatement[] {
  const replayed = `backup_raw_objects.status='copied' AND EXISTS(SELECT 1 FROM retention_run_objects r WHERE r.batch_id=backup_raw_objects.batch_id
    AND r.created_at>=backup_raw_objects.copied_at)`;
  return jsonChunks(copies).flatMap(chunk => [
    env.DB.prepare(`INSERT INTO backup_raw_generations(batch_id,copied_at,batch_received_at,superseded_at)
      SELECT backup_raw_objects.batch_id,backup_raw_objects.copied_at,backup_raw_objects.batch_received_at,? FROM backup_raw_objects
      WHERE backup_raw_objects.batch_id IN (SELECT json_extract(value,'$.batch_id') FROM json_each(?) WHERE json_extract(value,'$.status')='copied')
      AND ${replayed} ON CONFLICT DO NOTHING`).bind(now, chunk),
    env.DB.prepare(`INSERT INTO backup_raw_objects(batch_id,r2_key,batch_received_at,status,size,sha256,copied_at,first_checkpoint_id,checked_at)
      SELECT json_extract(value,'$.batch_id'),json_extract(value,'$.r2_key'),json_extract(value,'$.batch_received_at'),json_extract(value,'$.status'),
      json_extract(value,'$.size'),json_extract(value,'$.sha256'),?,json_extract(value,'$.first_checkpoint_id'),? FROM json_each(?) WHERE true
      ON CONFLICT(batch_id) DO UPDATE SET status=excluded.status,size=excluded.size,sha256=excluded.sha256,batch_received_at=excluded.batch_received_at,
      copied_at=excluded.copied_at,deleted_at=NULL,verified_at=NULL WHERE excluded.status='copied' AND (backup_raw_objects.status!='copied' OR ${replayed})`)
      .bind(now, now, chunk),
  ]);
}

/** RAW.get → BACKUP.put with the SHA-256 so R2 verifies the bytes; null when the source is gone. */
async function copyOne(env: Env, r2Key: string): Promise<{ size: number; sha256: string } | null> {
  const object = await env.RAW.get(r2Key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return { size: bytes.byteLength, sha256: await put(env.BACKUP!, rawCopyKey(r2Key), bytes) };
}

/** Copy settled raw batches not yet tracked in backup_raw_objects (2 R2 calls each). */
async function copyRaw(env: Env, ctx: MaintenanceContext, limits: BackupLimits, result: Row) {
  if (!room(ctx, limits.allotment, { d1: 7, r2: 2 })) return;
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
  const copies: Copy[] = [];
  let missing = 0;
  for (const row of rows.results) {
    if (!room(ctx, limits.allotment, { d1: 6, r2: 2 })) break;
    const copy = await copyOne(env, row.r2_key);
    const base = { batch_id: row.id, r2_key: row.r2_key, batch_received_at: row.received_at, first_checkpoint_id: running };
    if (!copy) { missing++; copies.push({ ...base, status: 'source_missing', size: null, sha256: null }); continue; }
    copies.push({ ...base, status: 'copied', ...copy });
  }
  if (!copies.length) return;
  const now = iso(ctx.now), last = copies.at(-1)!;
  const statements = recordCopies(env, copies, now);
  statements.push(env.DB.prepare('UPDATE backup_state SET raw_cursor=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?')
    .bind(JSON.stringify([last.batch_received_at, last.batch_id]), now, state.revision));
  const results = await env.DB.batch(statements);
  // Copies are idempotent; a lost cursor race only means another invocation got further.
  result.raw_copied = copies.length - missing;
  result.raw_source_missing = missing;
  if (results.at(-1)!.meta.changes !== 1) result.raw_cursor_conflict = true;
}

/**
 * Look again for raw sources that were missing at copy time, longest-unchecked first: a device
 * may have resent the same batch (same bytes, same key) or an operator restored the object.
 */
async function retryMissing(env: Env, ctx: MaintenanceContext, limits: BackupLimits, result: Row) {
  if (limits.missingRetryPerTick <= 0 || !room(ctx, limits.allotment, { d1: 4, r2: 2 })) return;
  // NULL sorts first, then the oldest check; only batches that still exist can be copied.
  const rows = await env.DB.prepare(`SELECT o.batch_id,o.r2_key,b.received_at FROM backup_raw_objects o JOIN batches b ON b.id=o.batch_id
    WHERE o.status='source_missing' ORDER BY o.checked_at,o.batch_id LIMIT ?`).bind(limits.missingRetryPerTick)
    .all<{ batch_id: string; r2_key: string; received_at: string }>();
  const copies: Copy[] = [], still: string[] = [];
  for (const row of rows.results) {
    if (!room(ctx, limits.allotment, { d1: 3, r2: 2 })) break;
    const copy = await copyOne(env, row.r2_key);
    if (!copy) { still.push(row.batch_id); continue; }
    copies.push({ batch_id: row.batch_id, r2_key: row.r2_key, batch_received_at: row.received_at, first_checkpoint_id: null, status: 'copied', ...copy });
  }
  if (!copies.length && !still.length) return;
  const now = iso(ctx.now);
  await env.DB.batch([...recordCopies(env, copies, now), ...jsonChunks(still).map(chunk => env.DB.prepare(`UPDATE backup_raw_objects SET checked_at=?
    WHERE status='source_missing' AND batch_id IN (SELECT value FROM json_each(?))`).bind(now, chunk))]);
  result.raw_missing_recovered = copies.length;
  result.raw_missing_checked = copies.length + still.length;
}

// ---- retention follow-up ----------------------------------------------------------

/**
 * Whether a checkpoint listed the copy of backup_raw_objects row `o`, decided from the current
 * row and every earlier generation a re-copy replaced. `through`, `listed` and `started` are SQL
 * expressions for the checkpoint's batches_through, raw_listed_at and started_at (columns or `?`).
 * A generation is listed when it was copied before the listing and no retention run deleted its
 * batch between that copy and the checkpoint's start (apply is refused while a checkpoint runs).
 */
function listedBy(through: string, listed: string, started: string): string {
  const notDeleted = (copied: string) => `NOT EXISTS(SELECT 1 FROM retention_run_objects r WHERE r.batch_id=o.batch_id
    AND r.created_at<${started} AND r.created_at>=${copied})`;
  return `((o.batch_received_at<=${through} AND o.copied_at<=${listed} AND ${notDeleted('o.copied_at')})
    OR EXISTS(SELECT 1 FROM backup_raw_generations g WHERE g.batch_id=o.batch_id AND g.batch_received_at<=${through} AND g.copied_at<=${listed}
      AND ${notDeleted('g.copied_at')}))`;
}

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
  if (room(ctx, limits.allotment, { d1: 5, r2: 1 })) {
    // Only the newest run of a batch decides when its shared BACKUP copy goes: a replayed batch
    // deleted again by a later run keeps its copy until that run's own grace period ends.
    const due = await env.DB.prepare(`SELECT r.run_id,r.batch_id,r.r2_key FROM retention_run_objects r
      WHERE r.backup_deleted_at IS NULL AND r.backup_delete_after<=? AND ${live}
      AND NOT EXISTS(SELECT 1 FROM retention_run_objects n WHERE n.batch_id=r.batch_id
        AND (n.created_at>r.created_at OR (n.created_at=r.created_at AND n.run_id>r.run_id)))
      ORDER BY r.backup_delete_after,r.run_id,r.batch_id LIMIT ?`)
      .bind(now, limits.pruneBatch).all<{ run_id: string; batch_id: string; r2_key: string }>();
    if (due.results.length) {
      await env.BACKUP!.delete(due.results.map(row => rawCopyKey(row.r2_key)));
      const batches = JSON.stringify(due.results.map(row => row.batch_id));
      await env.DB.batch([
        // Every checkpoint that listed one of these copies (in any generation) can no longer restore its raw lines.
        env.DB.prepare(`UPDATE backup_checkpoints SET raw_pruned_at=?,updated_at=? WHERE raw_pruned_at IS NULL AND status!='expired'
          AND raw_listed_at IS NOT NULL AND batches_through IS NOT NULL AND EXISTS(SELECT 1 FROM backup_raw_objects o
          WHERE o.batch_id IN (SELECT value FROM json_each(?)) AND ${listedBy('backup_checkpoints.batches_through', 'backup_checkpoints.raw_listed_at',
            'backup_checkpoints.started_at')})`).bind(now, now, batches),
        // The copy is gone for every run of the batch, including runs a later one superseded.
        env.DB.prepare(`UPDATE retention_run_objects SET backup_deleted_at=? WHERE backup_deleted_at IS NULL
          AND batch_id IN (SELECT value FROM json_each(?))`).bind(now, batches),
        env.DB.prepare(`UPDATE backup_raw_objects SET status='deleted',deleted_at=?,verified_at=NULL WHERE status!='deleted'
          AND batch_id IN (SELECT value FROM json_each(?))`).bind(now, batches),
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

/**
 * Where a running checkpoint's rounds stand, stored as JSON in backup_checkpoints.cursor. Rounds
 * export the batch tables, then every ledger, then every revised table present when the
 * checkpoint started (operations-shared.ts); the final snapshot comes last.
 */
type Rounds = {
  v: 2;
  /** 'batches' (batches with their events and versions), then ledger and revised tables. */
  order: string[];
  /** Index into order of the round in progress; order.length means the final snapshot is next. */
  stage: number;
  batches: [string, string] | null;
  rowids: Record<string, number>;
  /** When each revised table's first round began. */
  since: Record<string, string>;
  /** The final snapshot sent one table back for another round: return to it straight afterwards. */
  revisit?: boolean;
};
type Piece = { table: string; row: Row; revision?: boolean };
type ChunkRecord = { seq: number; key: string; sha256: string; bytes: number; rows: string; revisions: string | null };
const ROWID = '__beacon_rowid';

async function readRounds(env: Env, cp: Checkpoint): Promise<Rounds> {
  const stored = cp.cursor ? JSON.parse(cp.cursor) as Rounds | [string, string] : null;
  if (stored && !Array.isArray(stored)) return stored;
  // A new checkpoint, or one started before rounds existed (its cursor was the batch position).
  const tables = await tableSet(env.DB);
  const order = ['batches', ...[...LEDGER_TABLES, ...Object.keys(REVISED_TABLES)].filter(name => tables.has(name))];
  return { v: 2, order, stage: 0, batches: stored, rowids: {}, since: {} };
}
function advance(rounds: Rounds): Rounds {
  return rounds.revisit ? { ...rounds, stage: rounds.order.length, revisit: false } : { ...rounds, stage: rounds.stage + 1 };
}

/** Lines in objects of at most objectMaxBytes; each object counts its base rows and its revisions per table. */
function pack(pieces: Piece[], limits: BackupLimits, names: string[] = [], maxBytes = Infinity) {
  const objects: { lines: string[]; bytes: number; rows: Record<string, number>; revisions: Record<string, number> }[] =
    [{ lines: [], bytes: 0, rows: Object.fromEntries(names.map(name => [name, 0])), revisions: {} }];
  let size = 0;
  for (const piece of pieces) {
    const text = line(piece.table, piece.row, piece.revision), bytes = encoder.encode(text).byteLength + 1;
    size += bytes;
    if (size > maxBytes) throw new BackupFailure('final_snapshot_too_large');
    let current = objects.at(-1)!;
    if (current.lines.length && current.bytes + bytes > limits.objectMaxBytes) { current = { lines: [], bytes: 0, rows: {}, revisions: {} }; objects.push(current); }
    current.lines.push(text); current.bytes += bytes;
    const counts = piece.revision ? current.revisions : current.rows;
    counts[piece.table] = (counts[piece.table] ?? 0) + 1;
  }
  return objects;
}
async function writeObjects(env: Env, cp: Checkpoint, objects: ReturnType<typeof pack>): Promise<ChunkRecord[]> {
  const chunks: ChunkRecord[] = [];
  let seq = cp.chunk_count;
  for (const object of objects) {
    seq++;
    const key = chunkKey(cp.id, 'd1', seq), body = ndjson(object.lines);
    chunks.push({ seq, key, sha256: await put(env.BACKUP!, key, body), bytes: body.byteLength, rows: JSON.stringify(object.rows),
      revisions: Object.keys(object.revisions).length ? JSON.stringify(object.revisions) : null });
  }
  return chunks;
}
function insertChunks(env: Env, cp: Checkpoint, kind: 'rows' | 'final', chunks: ChunkRecord[], now: string, phase: string, owner: string) {
  return env.DB.prepare(`INSERT INTO backup_chunks(checkpoint_id,seq,kind,key,sha256,bytes,rows,revisions,created_at)
    SELECT ?,json_extract(value,'$.seq'),?,json_extract(value,'$.key'),json_extract(value,'$.sha256'),json_extract(value,'$.bytes'),
    json_extract(value,'$.rows'),json_extract(value,'$.revisions'),? FROM json_each(?)
    WHERE EXISTS(SELECT 1 FROM backup_checkpoints WHERE id=? AND phase=? AND chunk_count=? AND lease_owner=?)`)
    .bind(cp.id, kind, now, JSON.stringify(chunks), cp.id, phase, cp.chunk_count + chunks.length, owner);
}
/** Record a round: the new position and its objects in one D1 batch, behind the lease and the old position. */
async function commitRound(env: Env, ctx: MaintenanceContext, cp: Checkpoint, owner: string, rounds: Rounds, chunks: ChunkRecord[],
  through: string | null): Promise<Checkpoint> {
  const now = iso(ctx.now);
  const statements = [env.DB.prepare(`UPDATE backup_checkpoints SET cursor=?,chunk_count=?,batches_through=?,updated_at=?
    WHERE id=? AND status='running' AND phase='chunks' AND lease_owner=? AND chunk_count=? AND cursor IS ? RETURNING *`)
    .bind(JSON.stringify(rounds), cp.chunk_count + chunks.length, through, now, cp.id, owner, cp.chunk_count, cp.cursor)];
  if (chunks.length) statements.push(insertChunks(env, cp, 'rows', chunks, now, 'chunks', owner));
  const [updated] = await env.DB.batch(statements);
  const next = updated.results[0] as Checkpoint | undefined;
  if (!next) throw new MaintenanceError('backup_cas_conflict');
  return next;
}

async function chunkStep(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string): Promise<Checkpoint | Stop> {
  const rounds = await readRounds(env, cp);
  if (rounds.stage >= rounds.order.length) return finalStep(env, ctx, cp, limits, owner, rounds);
  const table = rounds.order[rounds.stage];
  return table === 'batches' ? batchRound(env, ctx, cp, limits, owner, rounds) : tableRound(env, ctx, cp, limits, owner, rounds, table);
}

/** Settled batches with their own events and versions, in (received_at,id) order. */
async function batchRound(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string, rounds: Rounds): Promise<Checkpoint | Stop> {
  if (!room(ctx, limits.allotment, { d1: 6, r2: 1 })) return 'budget';
  const range = after(rounds.batches);
  const pick = `SELECT id FROM batches WHERE received_at<? AND ${range.sql} ORDER BY received_at,id LIMIT ?`;
  const args = [iso(ctx.now.getTime() - limits.settleMs), ...range.args, limits.chunkBatches];
  // One D1 batch is one transaction, so a batch row always travels with its own events and versions.
  const [batches, events, versions] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM batches WHERE id IN (${pick}) ORDER BY received_at,id`).bind(...args),
    env.DB.prepare(`SELECT * FROM events WHERE batch_id IN (${pick}) ORDER BY batch_id,rowid`).bind(...args),
    env.DB.prepare(`SELECT * FROM event_versions WHERE batch_id IN (${pick}) ORDER BY batch_id,rowid`).bind(...args),
  ]);
  const rows: Record<typeof BATCH_TABLES[number], Row[]> = { batches: batches.results as Row[], events: events.results as Row[],
    event_versions: versions.results as Row[] };
  const pieces = BATCH_TABLES.flatMap(table => rows[table].map(row => ({ table, row })));
  const chunks = pieces.length ? await writeObjects(env, cp, pack(pieces, limits)) : [];
  const last = rows.batches.at(-1);
  let next: Rounds = { ...rounds, batches: last ? [String(last.received_at), String(last.id)] : rounds.batches };
  if (rows.batches.length < limits.chunkBatches) next = advance(next);
  return commitRound(env, ctx, cp, owner, next, chunks, last ? latest(cp.batches_through, String(last.received_at)) : cp.batches_through);
}

/** One page of a ledger or revised table by rowid: rows are never deleted, so every later row lands past the position. */
async function tableRound(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string, rounds: Rounds,
  table: string): Promise<Checkpoint | Stop> {
  if (!room(ctx, limits.allotment, { d1: 4, r2: 1 })) return 'budget';
  const page = Math.min(REVISED_TABLES[table]?.page ?? limits.tablePageRows, limits.tablePageRows);
  let next: Rounds = { ...rounds, rowids: { ...rounds.rowids }, since: { ...rounds.since } };
  if (REVISED_TABLES[table] && !next.since[table]) next.since[table] = iso(ctx.now);
  const rows = (await env.DB.prepare(`SELECT rowid AS ${ROWID},* FROM ${quoted(table)} WHERE rowid>? ORDER BY rowid LIMIT ?`)
    .bind(rounds.rowids[table] ?? 0, page).all<Row>()).results;
  const pieces = rows.map(({ [ROWID]: _rowid, ...row }) => ({ table, row }));
  const chunks = pieces.length ? await writeObjects(env, cp, pack(pieces, limits)) : [];
  if (rows.length) next.rowids[table] = Number(rows.at(-1)![ROWID]);
  if (rows.length < page) next = advance(next);
  return commitRound(env, ctx, cp, owner, next, chunks, cp.batches_through);
}

/**
 * ONE D1 batch (one transaction): the small reference tables whole, the tail of every round table
 * past its position, and every revised row that may have changed since its round. Every table's
 * exported rows are therefore exactly its rows at this moment (rows are never deleted while a
 * checkpoint runs), so the checkpoint is foreign-key closed; only events.project_id can drift,
 * which restore-check reports as a finding. Upper bounds are read first, so no statement can
 * return more rows than the snapshot's total budget allows.
 */
async function finalStep(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string, rounds: Rounds): Promise<Checkpoint | Stop> {
  const all = await userTables(env.DB), present = new Set(all.map(table => table.name));
  const chunked = rounds.order.filter(name => name !== 'batches' && present.has(name));
  const revised = chunked.filter(name => REVISED_TABLES[name]);
  const finals = all.filter(table => !(BATCH_TABLES as readonly string[]).includes(table.name) && !rounds.order.includes(table.name)
    && !BACKUP_BOOKKEEPING.has(table.name));
  const measured = [...chunked, ...finals.filter(table => table.rowid).map(table => table.name)];
  const groups = Array.from({ length: Math.ceil(measured.length / 20) }, (_, index) => measured.slice(index * 20, index * 20 + 20));
  const plain = finals.filter(table => !table.rowid);
  const reads = 3 + chunked.length + revised.length + finals.length;
  const maxObjects = Math.ceil(limits.finalMaxBytes / limits.objectMaxBytes) + 1;
  if (!room(ctx, limits.allotment, { d1: 1 + groups.length + plain.length + revised.length + reads + 2, r2: maxObjects })) return 'budget';
  const range = after(rounds.batches), settled = iso(ctx.now.getTime() - limits.settleMs);
  const since = (table: string) => iso(Date.parse(rounds.since[table] ?? iso(ctx.now)) - limits.revisionMarginMs);
  const touched = (table: string) => REVISED_TABLES[table].touched.join(' UNION ');
  const revisionArgs = (table: string) => [rounds.rowids[table] ?? 0, ...REVISED_TABLES[table].touched.map(() => since(table))];
  // Upper bounds, read without a transaction: MAX(rowid) bounds a table that never loses rows, and
  // the rows past a position; bounded counts cover the batch tail and the re-read rows.
  const estimates = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(event_count),0) AS events,COALESCE(SUM(received_at<?),0) AS settled
      FROM (SELECT received_at,event_count FROM batches WHERE ${range.sql} ORDER BY received_at,id LIMIT ?)`).bind(settled, ...range.args, limits.tailBatches + 1),
    ...groups.map(group => env.DB.prepare('SELECT ' + group.map((name, index) => `(SELECT MAX(rowid) FROM ${quoted(name)}) AS c${index}`).join(','))),
    ...plain.map(table => env.DB.prepare(`SELECT COUNT(*) AS c0 FROM (SELECT 1 FROM ${quoted(table.name)} LIMIT ?)`).bind(limits.finalMaxRows + 1)),
    ...revised.map(table => env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${quoted(table)} WHERE rowid<=? AND rowid IN (${touched(table)}) LIMIT ?)`)
      .bind(...revisionArgs(table), limits.revisionMaxRows + 1)),
  ]);
  const tail = estimates[0].results[0] as { n: number; events: number; settled: number };
  const bound = new Map<string, number>();
  groups.forEach((group, index) => {
    const row = estimates[1 + index].results[0] as Record<string, number | null>;
    group.forEach((name, column) => bound.set(name, row[`c${column}`] ?? 0));
  });
  plain.forEach((table, index) => bound.set(table.name, (estimates[1 + groups.length + index].results[0] as { c0: number }).c0));
  const revisions = new Map(revised.map((table, index) => [table, (estimates[1 + groups.length + plain.length + index].results[0] as { n: number }).n]));
  const back = (table: string) => commitRound(env, ctx, cp, owner, { ...rounds, stage: rounds.order.indexOf(table), revisit: true }, [], cp.batches_through);
  // Too much recent ingest to carry in one transaction: another batch round first, or wait for it to settle.
  if (tail.n > limits.tailBatches) return tail.settled ? back('batches') : 'wait';
  const tails = new Map(chunked.map(name => [name, Math.max(0, (bound.get(name) ?? 0) - (rounds.rowids[name] ?? 0))]));
  for (const [name, size] of tails) if (size > limits.tailRows) return back(name);
  for (const count of revisions.values()) if (count > limits.revisionMaxRows) throw new BackupFailure('final_snapshot_too_large');
  // Reference tables and re-read rows cannot shrink; tails can, with another round.
  const fixed = finals.reduce((sum, table) => sum + (bound.get(table.name) ?? 0), 0) + [...revisions.values()].reduce((sum, count) => sum + count, 0);
  if (fixed > limits.finalMaxRows) throw new BackupFailure('final_snapshot_too_large');
  const batchRows = tail.n + 2 * tail.events, tailRows = [...tails.values()].reduce((sum, size) => sum + size, 0);
  if (fixed + batchRows + tailRows > limits.finalMaxRows) {
    const [largest, size] = [...tails].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (tail.settled && batchRows > size) return back('batches');
    if (size > 0) return back(largest);
    throw new BackupFailure('final_snapshot_too_large');
  }
  // Spread what is left of the budget as growth room; a statement that fills its limit means the
  // table grew past its bound since it was read, and the snapshot is taken again later.
  const slack = Math.max(0, Math.min(1000, Math.floor((limits.finalMaxRows - fixed - batchRows - tailRows) / reads)));
  const limit = (base: number) => base + slack + 1;
  const tailIds = `SELECT id FROM batches WHERE ${range.sql} ORDER BY received_at,id LIMIT ?`, tailArgs = [...range.args, limit(tail.n)];
  const statements: [D1PreparedStatement, number][] = [
    [env.DB.prepare(`SELECT * FROM batches WHERE id IN (${tailIds}) ORDER BY received_at,id`).bind(...tailArgs), limit(tail.n)],
    [env.DB.prepare(`SELECT * FROM events WHERE batch_id IN (${tailIds}) ORDER BY batch_id,rowid LIMIT ?`).bind(...tailArgs, limit(tail.events)), limit(tail.events)],
    [env.DB.prepare(`SELECT * FROM event_versions WHERE batch_id IN (${tailIds}) ORDER BY batch_id,rowid LIMIT ?`).bind(...tailArgs, limit(tail.events)), limit(tail.events)],
    ...chunked.map(name => [env.DB.prepare(`SELECT * FROM ${quoted(name)} WHERE rowid>? ORDER BY rowid LIMIT ?`)
      .bind(rounds.rowids[name] ?? 0, limit(tails.get(name)!)), limit(tails.get(name)!)] as [D1PreparedStatement, number]),
    ...revised.map(name => [env.DB.prepare(`SELECT * FROM ${quoted(name)} WHERE rowid<=? AND rowid IN (${touched(name)}) ORDER BY rowid LIMIT ?`)
      .bind(...revisionArgs(name), limit(revisions.get(name)!)), limit(revisions.get(name)!)] as [D1PreparedStatement, number]),
    ...finals.map(table => [env.DB.prepare(`SELECT * FROM ${quoted(table.name)} ${table.rowid ? 'ORDER BY rowid' : ''} LIMIT ?`)
      .bind(limit(bound.get(table.name) ?? 0)), limit(bound.get(table.name) ?? 0)] as [D1PreparedStatement, number]),
  ];
  const results = await env.DB.batch(statements.map(([statement]) => statement));
  if (results.some((result, index) => result.results.length >= statements[index][1])) return 'wait';
  const pieces: Piece[] = [];
  BATCH_TABLES.forEach((table, index) => { for (const row of results[index].results as Row[]) pieces.push({ table, row }); });
  chunked.forEach((table, index) => { for (const row of results[3 + index].results as Row[]) pieces.push({ table, row }); });
  revised.forEach((table, index) => { for (const row of results[3 + chunked.length + index].results as Row[]) pieces.push({ table, row, revision: true }); });
  finals.forEach((table, index) => { for (const row of results[3 + chunked.length + revised.length + index].results as Row[]) pieces.push({ table: table.name, row }); });
  // The first object's row counts name every exported table, including empty ones, so the manifest lists them all.
  const chunks = await writeObjects(env, cp, pack(pieces, limits, [...BATCH_TABLES, ...chunked, ...finals.map(table => table.name)], limits.finalMaxBytes));
  const now = iso(ctx.now), seq = cp.chunk_count + chunks.length;
  const through = (results[0].results as Row[]).reduce<string | null>((value, row) => latest(value, String(row.received_at)), cp.batches_through);
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE backup_checkpoints SET phase='raw',cursor=NULL,chunk_count=?,final_snapshot_at=?,batches_through=?,updated_at=?
      WHERE id=? AND status='running' AND phase='chunks' AND lease_owner=? AND chunk_count=? AND cursor IS ? RETURNING *`)
      .bind(seq, now, through, now, cp.id, owner, cp.chunk_count, cp.cursor),
    insertChunks(env, cp, 'final', chunks, now, 'raw', owner),
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
  raw_listed_at: string; consistency: string; chunked_tables: string[]; ledger_tables: string[]; revised_tables: string[]; excluded_tables: string[];
  migrations: string[]; table_counts: Record<string, number>; chunks: { seq: number; kind: 'rows' | 'final' | 'raw_list'; key: string; sha256: string;
    bytes: number; rows: Record<string, number>; revisions?: Record<string, number> }[]; raw: { prefix: 'raw/'; objects: number; bytes: number };
};

async function manifestStep(env: Env, ctx: MaintenanceContext, cp: Checkpoint, limits: BackupLimits, owner: string): Promise<Checkpoint | Stop> {
  // A two-statement batch, the migrations ledger (present on every wrangler-migrated D1) and the completing update.
  if (!room(ctx, limits.allotment, { d1: 4, r2: 1 })) return 'budget';
  const [chunkRows, ledger] = await env.DB.batch([
    env.DB.prepare('SELECT seq,kind,key,sha256,bytes,rows,revisions FROM backup_chunks WHERE checkpoint_id=? ORDER BY seq').bind(cp.id),
    env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'"),
  ]);
  const migrations = ledger.results.length
    ? (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map(row => row.name) : [];
  // Revisions replace rows an earlier round exported, so table counts add up base rows only.
  const chunks = (chunkRows.results as { seq: number; kind: 'rows' | 'final' | 'raw_list'; key: string; sha256: string; bytes: number; rows: string;
    revisions: string | null }[]).map(({ revisions, ...chunk }) => ({ ...chunk, rows: JSON.parse(chunk.rows) as Record<string, number>,
    ...(revisions ? { revisions: JSON.parse(revisions) as Record<string, number> } : {}) }));
  const counts: Record<string, number> = {};
  for (const chunk of chunks) if (chunk.kind !== 'raw_list') for (const [table, count] of Object.entries(chunk.rows)) counts[table] = (counts[table] ?? 0) + count;
  const tableCounts = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : 1));
  const manifest: Manifest = { format: 'beacon.backup.v1', checkpoint_id: cp.id, started_at: cp.started_at, final_snapshot_at: cp.final_snapshot_at!,
    batches_through: cp.batches_through, raw_listed_at: cp.raw_listed_at!, consistency: 'rounds_then_final_snapshot',
    chunked_tables: [...BATCH_TABLES], ledger_tables: LEDGER_TABLES.filter(name => name in tableCounts),
    revised_tables: Object.keys(REVISED_TABLES).filter(name => name in tableCounts), excluded_tables: [...BACKUP_BOOKKEEPING].sort(), migrations,
    table_counts: tableCounts, chunks,
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
      // The metered binding throws synchronously once the allotment is spent; keep the original error either way.
      try { await env.DB.prepare('UPDATE backup_checkpoints SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?').bind(cp.id, owner).run(); }
      catch { /* the lease expires on its own */ }
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

type IntegrityCursor = { stage: 'manifest' } | { stage: 'chunks'; seq: number; index?: number };
/** Calls and time one integrity pass may use: a slice of the tick before the checkpoint advances, the rest after. */
type IntegrityBudget = { allotment: Allotment; minimumMs: number; reads: { left: number } };
const RAW_VERIFY_GROUP = 1000;

/**
 * Re-hash the manifest and every chunk object of the newest completed checkpoint that has not
 * passed yet, and HEAD (size and stored SHA-256) the raw copies its raw lists name that no
 * earlier pass verified. Copies are content-addressed and shared, so each is verified once
 * (backup_raw_objects.verified_at, reset whenever it is written again).
 */
async function checkIntegrity(env: Env, ctx: MaintenanceContext, budget: IntegrityBudget, result: Row) {
  if (budget.reads.left <= 0 || !room(ctx, budget.allotment, { d1: 4, r2: 1 }, budget.minimumMs)) return;
  // Newest first: retention can only rely on the newest verified checkpoint within BACKUP_MAX_AGE_DAYS.
  const cp = await env.DB.prepare(`SELECT * FROM backup_checkpoints WHERE status IN ('completed','verified')
    AND integrity_verified_at IS NULL AND integrity_error IS NULL ORDER BY completed_at DESC,id DESC LIMIT 1`).first<Checkpoint>();
  if (!cp) return;
  let cursor: IntegrityCursor = cp.integrity_cursor ? JSON.parse(cp.integrity_cursor) : { stage: 'manifest' };
  if (Array.isArray((cursor as { seq?: unknown }).seq) || (cursor as { stage: string }).stage === 'raw') cursor = { stage: 'chunks', seq: 0 };
  let spent = 0, verified = 0, failure: string | null = null, done = false;
  const affordable = (d1 = 3) => spent < budget.reads.left && room(ctx, budget.allotment, { d1, r2: 1 }, budget.minimumMs);
  const fetchBytes = async (key: string) => { spent++; const object = await env.BACKUP!.get(key); return object ? new Uint8Array(await object.arrayBuffer()) : null; };
  outer: while (!failure && !done && affordable()) {
    if (cursor.stage === 'manifest') {
      const bytes = await fetchBytes(cp.manifest_key!);
      if (!bytes) { failure = 'manifest_missing'; break; }
      if (await digest(bytes) !== cp.manifest_sha256) { failure = 'manifest_mismatch'; break; }
      cursor = { stage: 'chunks', seq: 0 };
      continue;
    }
    const chunks = await env.DB.prepare('SELECT seq,kind,key,sha256,bytes FROM backup_chunks WHERE checkpoint_id=? AND seq>? ORDER BY seq LIMIT 50')
      .bind(cp.id, cursor.seq).all<{ seq: number; kind: string; key: string; sha256: string; bytes: number }>();
    if (!chunks.results.length) { done = true; break; }
    for (const chunk of chunks.results) {
      if (!affordable()) break outer;
      const bytes = await fetchBytes(chunk.key);
      if (!bytes) { failure = 'chunk_missing'; break outer; }
      if (bytes.byteLength !== chunk.bytes || await digest(bytes) !== chunk.sha256) { failure = 'chunk_mismatch'; break outer; }
      if (chunk.kind === 'raw_list') {
        const entries = new TextDecoder().decode(bytes).split('\n').filter(Boolean)
          .map(text => JSON.parse(text) as { batch_id: string; key: string; size: number; sha256: string });
        let index = cursor.index ?? 0;
        while (index < entries.length) {
          // One lookup per group, one HEAD per copy not verified yet, one update per group.
          if (!affordable(4)) { cursor = { stage: 'chunks', seq: cursor.seq, index }; break outer; }
          const group = entries.slice(index, index + RAW_VERIFY_GROUP);
          const known = await env.DB.prepare(`SELECT batch_id FROM backup_raw_objects WHERE status='copied' AND verified_at IS NOT NULL
            AND batch_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(group.map(entry => entry.batch_id))).all<{ batch_id: string }>();
          const skip = new Set(known.results.map(row => row.batch_id)), checked: string[] = [];
          let position = 0;
          for (; position < group.length; position++) {
            const entry = group[position];
            if (skip.has(entry.batch_id)) continue;
            if (!affordable(2)) break;
            spent++;
            const head = await env.BACKUP!.head(entry.key);
            if (!head) { failure = 'raw_missing'; break; }
            if (head.size !== entry.size || hex(head.checksums.sha256) !== entry.sha256) { failure = 'raw_mismatch'; break; }
            checked.push(entry.batch_id);
          }
          if (checked.length) {
            await env.DB.prepare(`UPDATE backup_raw_objects SET verified_at=? WHERE status='copied' AND verified_at IS NULL
              AND batch_id IN (SELECT value FROM json_each(?))`).bind(iso(ctx.now), JSON.stringify(checked)).run();
            verified += checked.length;
          }
          index += position;
          if (failure) break outer;
          if (position < group.length) { cursor = { stage: 'chunks', seq: cursor.seq, index }; break outer; }
        }
      }
      cursor = { stage: 'chunks', seq: chunk.seq };
    }
  }
  budget.reads.left -= spent;
  const now = iso(ctx.now);
  const update = await env.DB.prepare(`UPDATE backup_checkpoints SET integrity_cursor=?,integrity_verified_at=?,integrity_error=?,updated_at=?
    WHERE id=? AND integrity_cursor IS ? AND integrity_verified_at IS NULL AND integrity_error IS NULL`)
    .bind(JSON.stringify(cursor), done ? now : null, failure, now, cp.id, cp.integrity_cursor).run();
  const previous = (result.integrity as { id?: string; checked?: number; raw_verified?: number } | undefined);
  const carried = previous?.id === cp.id ? previous : undefined;
  result.integrity = { id: cp.id, checked: spent + (carried?.checked ?? 0), raw_verified: verified + (carried?.raw_verified ?? 0),
    ...(done ? { verified: true } : {}), ...(failure ? { error: failure } : {}), ...(update.meta.changes ? {} : { conflict: true }) };
}

/** The part of the tick's remaining allotment and time a pass may use; share 1 leaves the whole tick. */
function slice(ctx: MaintenanceContext, allotment: Allotment, share: number, reads: { left: number }): IntegrityBudget {
  const used = ctx.usage(), part = (kind: keyof Allotment) => used[kind] + Math.floor(Math.max(0, allotment[kind] - used[kind]) * share);
  return { allotment: { d1: part('d1'), r2: part('r2'), fetch: part('fetch') }, minimumMs: Math.max(1000, Math.floor(ctx.remaining() * (1 - share))), reads };
}

/** Build the backup task; tests pass smaller limits to exercise multi-tick behavior. */
export function createBackupTask(overrides: Partial<BackupLimits> = {}): MaintenanceTask {
  const limits = { ...BACKUP_LIMITS, ...overrides };
  return {
    name: 'backup', schedule: 'hourly', allotment: limits.allotment,
    async run(env, ctx) {
      if (!env.BACKUP) throw new MaintenanceError('backup_not_configured');
      // Code deployed before migration 0008 was applied: report it rather than a generic failure.
      if (!await env.DB.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='backup_raw_generations'").first())
        throw new MaintenanceError('backup_schema_missing');
      const result: Row = {}, reads = { left: limits.integrityPerTick };
      await pruneRetained(env, ctx, limits, result);
      await copyRaw(env, ctx, limits, result);
      await retryMissing(env, ctx, limits, result);
      // Integrity gets its share first, so a long-running checkpoint cannot starve it, then whatever is left.
      await checkIntegrity(env, ctx, slice(ctx, limits.allotment, limits.integrityShare, reads), result);
      await advanceCheckpoint(env, ctx, limits, result);
      await checkIntegrity(env, ctx, slice(ctx, limits.allotment, 1, reads), result);
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
    // Decided from every generation of the copy: a replayed batch copied again after this
    // checkpoint listed it is still a member, while its object exists.
    return !!await env.DB.prepare(`SELECT 1 AS member FROM backup_raw_objects o WHERE o.r2_key=? AND o.status='copied' AND ${listedBy('?', '?', '?')}`)
      .bind(key.slice(4), cp.batches_through, cp.raw_listed_at, cp.started_at, cp.batches_through, cp.raw_listed_at, cp.started_at)
      .first();
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
