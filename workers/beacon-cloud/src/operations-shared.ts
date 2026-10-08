// Helpers shared by retention, backup and health. Results carry identifiers, counts,
// hashes and codes only, never event content.
import type { Allotment, MaintenanceContext } from './maintenance';
import { Env, HttpError } from './types';

// How a backup checkpoint exports each table (DATA-OPERATIONS.md). Every table a committed
// migration creates is classified here; a schema test fails until a new one is. A table that
// is not (one added by a later track and not yet classified) goes to the final snapshot,
// which is always consistent.

/** Batches with their own events and versions, exported together by (received_at,id) once settled. */
export const BATCH_TABLES = ['batches', 'events', 'event_versions'] as const;
/**
 * Append-only ledgers: unconditional triggers forbid every update and delete, so the rows a round
 * exports by rowid are exactly the rows at the final snapshot, which reads only the tail after them.
 */
export const LEDGER_TABLES = ['context_sources', 'context_audit', 'context_generation', 'context_flag_audit', 'context_share_audit',
  'processing_job_sources', 'processing_coverage', 'processing_signals', 'processing_job_audit', 'processing_policy_audit',
  'processing_budget_audit', 'device_sync_audit', 'retention_runs', 'retention_policy_audit'] as const;
/**
 * Tables that grow with activity and whose rows change: rounds export them by rowid (never deleted,
 * so membership is exact), then the final snapshot re-reads every exported row that may have changed
 * since its round. `touched` lists indexed queries for the rowids of rows changed at or after `?`,
 * a time a margin before the table's first round began. Every UPDATE these tables receive sets the
 * column a query reads (sessions: through the batch whose ingest changed them).
 */
export const REVISED_TABLES: Record<string, { page?: number; touched: string[] }> = {
  // Nested IN lists keep the walk on indexes: recent batches, their versions, those events, their sessions.
  sessions: { touched: [`SELECT s.rowid FROM sessions s WHERE s.id IN (SELECT e.session_id FROM events e WHERE e.id IN (
    SELECT v.event_id FROM event_versions v WHERE v.batch_id IN (SELECT b.id FROM batches b WHERE b.received_at>=?)))`] },
  processing_jobs: { touched: ['SELECT rowid FROM processing_jobs WHERE updated_at>=?'] },
  processing_calls: { touched: ['SELECT rowid FROM processing_calls WHERE finished_at>=?'] },
  // Content up to 12,000 characters per row: smaller pages keep each round's memory bounded.
  context_entries: { page: 200, touched: ['SELECT rowid FROM context_entries WHERE reviewed_at>=?',
    `SELECT p.rowid FROM context_entries p WHERE p.id IN (SELECT c.supersedes_id FROM context_entries c WHERE c.reviewed_at>=?
      AND c.supersedes_id IS NOT NULL)`] },
  context_flags: { page: 500, touched: ['SELECT rowid FROM context_flags WHERE resolved_at>=?'] },
  retention_run_objects: { touched: ['SELECT rowid FROM retention_run_objects WHERE raw_deleted_at>=?',
    'SELECT rowid FROM retention_run_objects WHERE backup_deleted_at>=?'] },
};
/** Small reference tables the final snapshot reads whole, in one transaction. */
export const SNAPSHOT_TABLES = ['devices', 'projects', 'project_groups', 'project_group_members', 'project_relations', 'tasks', 'task_sessions',
  'project_workflow_audit', 'processing_policies', 'processing_job_fence', 'processing_scan_cursor', 'processing_budget',
  'device_sync_subscriptions', 'retention_policies', 'context_shares'] as const;
/** Bookkeeping that describes BACKUP itself; restored databases do not need it. */
export const BACKUP_BOOKKEEPING = new Set(['backup_checkpoints', 'backup_chunks', 'backup_raw_objects', 'backup_raw_generations', 'backup_audit',
  'backup_state', 'health_state']);
export const RAW_KEY = /^batches\/[A-Za-z0-9_-]{1,80}\/(?:runtime|inventory)\/[a-f0-9]{64}\.ndjson$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const HASH = /^[a-f0-9]{64}$/;
/** Ingest stamps received_at before its D1 commit; anything older than this has committed. */
export const SETTLE_MS = 10 * 60_000;

export type TableInfo = { name: string; rowid: boolean };
/**
 * User tables from sqlite_master: D1 internals (`_cf_%`), SQLite internals and the
 * migrations ledger are excluded, so tables added by other tracks appear automatically.
 */
export async function userTables(db: D1Database): Promise<TableInfo[]> {
  const rows = await db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table'
    AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name!='d1_migrations'
    ORDER BY name`).all<{ name: string; sql: string | null }>();
  return rows.results.map(row => ({ name: row.name, rowid: !/WITHOUT\s+ROWID/i.test(row.sql || '') }));
}
export async function tableSet(db: D1Database): Promise<Set<string>> {
  return new Set((await userTables(db)).map(table => table.name));
}
export function quoted(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new HttpError(500, 'Unsupported table name');
  return '"' + name + '"';
}

export function iso(time: number | Date): string { return new Date(time).toISOString(); }
export function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return value !== undefined && /^\d+$/.test(value) && parsed >= min && parsed <= max ? parsed : fallback;
}
export const backupIntervalHours = (env: Env) => envInt(env.BACKUP_INTERVAL_HOURS, 24, 1, 720);
export const backupMaxAgeDays = (env: Env) => envInt(env.BACKUP_MAX_AGE_DAYS, 7, 1, 90);
export const retentionGraceDays = (env: Env) => envInt(env.BACKUP_RETENTION_GRACE_DAYS, 30, 0, 365);
export function scheduledTask(env: Env, name: string): boolean {
  return (env.MAINTENANCE_TASKS || '').split(',').map(value => value.trim()).includes(name);
}

/** Opaque keyset cursor `[time,id]`, the same shape as the other list routes. */
export function encodeCursor(time: string, id: string): string { return btoa(JSON.stringify([time, id])); }
export function decodeCursor(value: string | null, id: RegExp): [string, string] | null {
  if (value === null) return null;
  try {
    if (value.length > 512) throw new Error();
    const parsed = JSON.parse(atob(value));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string'
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed[0]) || !id.test(parsed[1])) throw new Error();
    return [parsed[0], parsed[1]];
  } catch { throw new HttpError(400, 'Invalid cursor'); }
}

/** Split items into JSON arrays small enough for one json_each(?) parameter. */
export function jsonChunks<T>(items: T[], maxBytes = 90_000): string[] {
  const chunks: string[] = [];
  let current: string[] = [], size = 2;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    if (current.length && size + encoded.length + 1 > maxBytes) { chunks.push('[' + current.join(',') + ']'); current = []; size = 2; }
    current.push(encoded); size += encoded.length + 1;
  }
  if (current.length) chunks.push('[' + current.join(',') + ']');
  return chunks;
}

/** True when the task can still afford `need` more calls and some wall time. */
export function room(ctx: MaintenanceContext, allotment: Allotment, need: Partial<Allotment>, minimumMs = 1000): boolean {
  const used = ctx.usage();
  return ctx.remaining() > minimumMs && used.d1 + (need.d1 ?? 0) <= allotment.d1
    && used.r2 + (need.r2 ?? 0) <= allotment.r2 && used.fetch + (need.fetch ?? 0) <= allotment.fetch;
}

export function hex(buffer: ArrayBuffer | undefined): string | null {
  return buffer ? [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('') : null;
}
