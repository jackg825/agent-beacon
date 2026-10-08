import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { BACKUP_ALLOTMENT, BackupLimits, Checkpoint, backupsWrite, createBackupTask } from '../src/backup';
import { contextWrite } from '../src/context';
import { runMaintenance } from '../src/maintenance';
import { Env } from '../src/types';
import { restoreCheck, bucketSource, verifyRequest, RestoreReport } from '../scripts/restore-check';
import { disposeOnFailure } from './env-fixture';
import { applyMigrations } from './migrations';
import { migrationFiles, migrationsDirectory, splitMigration } from '../scripts/migration-sql';

export const reviewer = 'reviewer:synthetic-operations';
/** Scheduled time far enough ahead that every synthetic batch has settled. */
export const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
export function post(path: string, body: unknown) {
  return new Request('http://localhost' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
export function get(path: string) { return new Request('http://localhost' + path); }

/** One hourly backup tick through the real scheduler, asserting the per-tick allotment. */
export async function backupTick(env: Env, now: Date, overrides: Partial<BackupLimits> = {}) {
  const report = await runMaintenance({ ...env, MAINTENANCE_TASKS: 'backup' } as Env, { now, tasks: [createBackupTask(overrides)], budgetMs: 120_000 });
  const tick = report.backup;
  for (const kind of ['d1', 'r2', 'fetch'] as const) assert.ok(tick.usage[kind] <= BACKUP_ALLOTMENT[kind], `backup ${kind} usage ${tick.usage[kind]}`);
  return tick;
}
export async function latestCheckpoint(env: Env) {
  return env.DB.prepare('SELECT * FROM backup_checkpoints ORDER BY started_at DESC,id DESC LIMIT 1').first<Checkpoint>();
}
/** Tick until the newest checkpoint is complete and its integrity pass has finished. */
export async function completeCheckpoint(env: Env, now: Date, overrides: Partial<BackupLimits> = {}) {
  for (let index = 0; index < 30; index++) {
    const tick = await backupTick(env, now, overrides);
    assert.equal(tick.ok, true, JSON.stringify(tick));
    const checkpoint = await latestCheckpoint(env);
    if (checkpoint && checkpoint.status !== 'running' && (checkpoint.integrity_verified_at || checkpoint.integrity_error || checkpoint.status === 'failed')) return checkpoint;
  }
  throw new Error('Checkpoint did not complete');
}
export async function drill(env: Env, checkpoint: Checkpoint, migrationsDirectory?: string): Promise<RestoreReport> {
  const workDir = await mkdtemp(join(tmpdir(), 'beacon-drill-'));
  try { return await restoreCheck({ checkpointId: checkpoint.id, source: bucketSource(env.BACKUP!), expectedManifestSha256: checkpoint.manifest_sha256!, workDir,
    migrationsDirectory }); }
  finally { await rm(workDir, { recursive: true, force: true }); }
}
/** Complete, drill and attest a checkpoint so retention can rely on it. */
export async function verifiedCheckpoint(env: Env, now: Date, overrides: Partial<BackupLimits> = {}, migrationsDirectory?: string) {
  const checkpoint = await completeCheckpoint(env, now, overrides);
  assert.ok(checkpoint.integrity_verified_at, 'integrity verified');
  const report = await drill(env, checkpoint, migrationsDirectory);
  assert.equal(report.result, 'passed', JSON.stringify(report.failures));
  const response = await backupsWrite(post(`/api/backups/${checkpoint.id}/verify`, verifyRequest(report)), env, reviewer);
  assert.equal(response!.status, 200);
  return { checkpoint: (await latestCheckpoint(env))!, report };
}

export async function createContext(env: Env, body: Record<string, unknown>, decision?: 'approve' | 'reject') {
  const created = await contextWrite(post('/api/context', body), env, reviewer);
  assert.equal(created!.status, 201, await created!.clone().text());
  const context = (await created!.json() as { context: { id: string } }).context;
  if (decision) {
    const reviewed = await contextWrite(post(`/api/context/${context.id}/review`, { decision }), env, reviewer);
    assert.equal(reviewed!.status, 200, await reviewed!.clone().text());
  }
  return context.id;
}

/**
 * Simulate a later track's committed migration (a table with a foreign key and a trigger):
 * apply it to the live fixture and return a migrations directory for the restore drill.
 */
export const trackMigration = `CREATE TABLE zz_track_notes(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), note TEXT);
CREATE TRIGGER zz_track_notes_no_delete BEFORE DELETE ON zz_track_notes
BEGIN
  SELECT RAISE(ABORT,'synthetic_immutable');
END;
`;
export async function addTrackMigration(env: Env) {
  for (const statement of splitMigration('0099_synthetic_track.sql', trackMigration)) await env.DB.prepare(statement.sql).run();
  const directory = await mkdtemp(join(tmpdir(), 'beacon-migrations-'));
  for (const name of await migrationFiles()) await copyFile(join(migrationsDirectory, name), join(directory, name));
  await writeFile(join(directory, '0099_synthetic_track.sql'), trackMigration);
  return directory + '/';
}

/**
 * STAND-IN for Track R's `context_flags`: its migration (0007) is not written yet, so this
 * holds only the columns health and retention read. It has no committed migration, so drop
 * it before a restore drill (which rightly refuses unknown tables). Replace it with the real
 * migration when Track R lands.
 */
export async function createContextFlagsStandIn(env: Env) {
  await env.DB.prepare('CREATE TABLE context_flags(id TEXT PRIMARY KEY, status TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL)').run();
}

export const operationsTokens = { read: 'synthetic-operations-read-key-0000000000', review: 'synthetic-operations-review-key-000000000',
  mcp: 'synthetic-operations-mcp-key-00000000000', mbp: 'synthetic-operations-mbp-key-00000000000' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** The bundled dist/worker.mjs with RAW and BACKUP buckets and every migration applied. */
export async function operationsWorker(bindings: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-operations-'));
  const mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'storage'), workers: [{
    name: 'beacon-operations', modules: true as const, scriptPath: resolve('dist/worker.mjs'), compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'operations-index' }, r2Buckets: { RAW: 'operations-raw', BACKUP: 'operations-backup' },
    bindings: { READ_TOKEN: operationsTokens.read, REVIEW_TOKEN: operationsTokens.review, MCP_TOKEN: operationsTokens.mcp, ...bindings } }] }));
  const close = async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); };
  const env = await disposeOnFailure(close, async () => {
    const db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').bind('mbp', 'Synthetic MBP', sha(operationsTokens.mbp), '2026-10-08T00:00:00Z').run();
    return { DB: db, RAW: await mf.getR2Bucket('RAW'), BACKUP: await mf.getR2Bucket('BACKUP') } as unknown as Env;
  });
  const request = (path: string, init: Parameters<typeof mf.dispatchFetch>[1] = {}) => mf.dispatchFetch('http://localhost' + path, init);
  return {
    mf, env, request,
    bearer: (path: string, token: string) => request(path, { headers: { Authorization: 'Bearer ' + token } }),
    write: (path: string, body: unknown, token = operationsTokens.review) => request(path, { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    upload: (records: unknown[]) => request('/v1/ingest/runtime', { method: 'POST', headers: { Authorization: 'Bearer ' + operationsTokens.mbp,
      'Content-Type': 'application/x-ndjson' }, body: records.map(record => JSON.stringify(record)).join('\n') + '\n' }),
    close,
  };
}
