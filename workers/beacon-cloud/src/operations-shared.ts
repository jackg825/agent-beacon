// Helpers shared by retention, backup and health. Results carry identifiers, counts,
// hashes and codes only, never event content.
import type { Allotment, MaintenanceContext } from './maintenance';
import { Env, HttpError } from './types';

/** Tables exported in chunks across ticks instead of in the final snapshot. */
export const CHUNKED_TABLES = ['batches', 'events', 'event_versions'] as const;
/** Bookkeeping that describes BACKUP itself; restored databases do not need it. */
export const BACKUP_BOOKKEEPING = new Set(['backup_checkpoints', 'backup_chunks', 'backup_raw_objects', 'backup_audit', 'backup_state', 'health_state']);
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
