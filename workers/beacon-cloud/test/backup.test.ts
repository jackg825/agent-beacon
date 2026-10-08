import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_BOOKKEEPING } from '../src/operations-shared';
import { Manifest, backupTask, backupsReviewerRead, backupsWrite, createBackupTask, expireCheckpoint } from '../src/backup';
import { revisionsWrite } from '../src/context-revisions';
import { runMaintenance } from '../src/maintenance';
import { Env } from '../src/types';
import { RestoreError, bucketSource, dirSource, httpSource, parseArgs, readReviewToken, reportSha256, restoreCheck, runCli, verifyRequest, workerUrl }
  from '../scripts/restore-check';
import { createEnvFixture, syntheticEvent } from './env-fixture';
import { addTrackMigration, backupTick, completeCheckpoint, createContext, drill, get, later, latestCheckpoint, operationsTokens, operationsWorker, post,
  reviewer, verifiedCheckpoint } from './operations-fixture';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function json(response: Response | null) { assert.ok(response); return response.json() as Promise<any>; }
async function objectText(env: Env, key: string) { return (await env.BACKUP!.get(key))!.text(); }
async function withDir<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-drill-'));
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Synthetic activity: two devices, an alternate capture across batches, an approved and a superseded note. */
async function seed(fixture: Awaited<ReturnType<typeof createEnvFixture>>) {
  await fixture.ingest([syntheticEvent('backup-1'), syntheticEvent('backup-2')]);
  await fixture.ingest([syntheticEvent('backup-3', { session: 'session-b' })], 'mini');
  await fixture.ingest([syntheticEvent('backup-1', { extra: { message: 'synthetic alternate capture' } })]);
  await fixture.ingest([syntheticEvent('backup-4', { repo: 'beta', session: 'session-c' })]);
  await fixture.ingest([syntheticEvent('backup-5'), syntheticEvent('backup-6', { action: 'session.start' })]);
  const event = (await fixture.event('backup-2'))!;
  const versions = await fixture.env.DB.prepare('SELECT payload_hash FROM event_versions WHERE event_id=?').bind((await fixture.event('backup-1'))!.id).all<{ payload_hash: string }>();
  assert.equal(versions.results.length, 2);
  const base = { kind: 'memory', project_id: event.project_id, title: 'Synthetic note', content: 'Synthetic content only.',
    sources: [{ event_id: event.id, payload_hash: event.payload_hash }] };
  const parent = await createContext(fixture.env, base, 'approve');
  const revision = await createContext(fixture.env, { ...base, title: 'Synthetic revision', supersedes_id: parent }, 'approve');
  await createContext(fixture.env, { ...base, kind: 'summary', title: 'Synthetic rejected' }, 'reject');
  // Track R rows, which the drill reloads with their triggers deferred: an open and a dismissed
  // flag with exact evidence, and a revoked then re-created share to another project.
  const revise = async (path: string, body: unknown) => {
    const response = await revisionsWrite(post(path, body), fixture.env, reviewer);
    assert.ok(response && response.status < 300, await response?.clone().text());
    return response!.json() as Promise<any>;
  };
  const evidence = [{ event_id: event.id, payload_hash: event.payload_hash }];
  await revise(`/api/context/${revision}/flags`, { kind: 'needs_review', note: 'Synthetic open flag', evidence });
  const dismissed = (await revise(`/api/context/${revision}/flags`, { kind: 'contradiction', evidence })).flag.id;
  await revise(`/api/context/flags/${dismissed}/resolve`, { resolution: 'dismissed', reason: 'Synthetic dismissal' });
  const target = { target_type: 'project', target_id: (await fixture.event('backup-4'))!.project_id };
  await revise(`/api/context/shares/${(await revise(`/api/context/${revision}/shares`, target)).share.id}/revoke`, {});
  await revise(`/api/context/${revision}/shares`, target);
  // A table (and trigger) added by a later track appears in the snapshot and the drill automatically.
  const migrations = await addTrackMigration(fixture.env);
  await fixture.env.DB.prepare('INSERT INTO zz_track_notes VALUES(?,?,?)').bind('synthetic-track-row', event.project_id, 'synthetic').run();
  return { event, parent, migrations };
}

test('backup stays inert until the BACKUP binding and the operator opt-in both exist', async () => {
  const bare = await createEnvFixture();
  const bound = await createEnvFixture({ backup: true });
  try {
    await bare.ingest([syntheticEvent('inert-1')]);
    assert.deepEqual(await runMaintenance(bare.env, { tasks: [backupTask], now: later(20) }), {});
    const report = await runMaintenance({ ...bare.env, MAINTENANCE_TASKS: 'backup' } as Env, { tasks: [backupTask], now: later(20) });
    assert.equal(report.backup.error, 'backup_not_configured');
    assert.deepEqual(report.backup.usage, { d1: 0, r2: 0, fetch: 0 });
    await bound.ingest([syntheticEvent('inert-2')]);
    assert.deepEqual(await runMaintenance(bound.env, { tasks: [backupTask], now: later(20), schedule: 'hourly' }), {});
    assert.equal((await bound.env.DB.prepare('SELECT COUNT(*) AS n FROM backup_checkpoints').first<{ n: number }>())!.n, 0);
    assert.equal((await bound.env.BACKUP!.list()).objects.length, 0);
    const refused = backupsWrite(post('/api/backups/run', {}), bare.env, reviewer);
    await assert.rejects(refused, (error: any) => error.status === 409);
  } finally { await bare.close(); await bound.close(); }
});

test('a checkpoint chunks rows, snapshots every other table, copies raw batches, passes integrity and restores', async (t) => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const { event, migrations } = await seed(fixture);
    const env = fixture.env, now = later(15);
    const checkpoint = await completeCheckpoint(env, now, { chunkBatches: 2 });
    assert.equal(checkpoint.status, 'completed');
    assert.ok(checkpoint.integrity_verified_at && !checkpoint.integrity_error);
    const manifest = JSON.parse(await objectText(env, checkpoint.manifest_key!)) as Manifest;
    await t.test('the manifest lists hashed chunks, every user table and the raw copies', async () => {
      assert.equal(sha(await objectText(env, checkpoint.manifest_key!)), checkpoint.manifest_sha256);
      assert.deepEqual([...new Set(manifest.chunks.map(chunk => chunk.kind))].sort(), ['final', 'raw_list', 'rows']);
      for (const chunk of manifest.chunks) assert.equal(sha(new Uint8Array(await (await env.BACKUP!.get(chunk.key))!.arrayBuffer())), chunk.sha256);
      const tables = (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
        AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name!='d1_migrations'`).all<{ name: string }>()).results.map(row => row.name)
        .filter(name => !BACKUP_BOOKKEEPING.has(name)).sort();
      assert.deepEqual(Object.keys(manifest.table_counts).sort(), tables);
      assert.ok(tables.includes('zz_track_notes') && !tables.includes('health_state'));
      for (const table of tables) {
        assert.equal(manifest.table_counts[table], (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>())!.n, table);
      }
      const batches = (await env.DB.prepare('SELECT COUNT(*) AS n FROM batches').first<{ n: number }>())!.n;
      assert.equal(manifest.raw.objects, batches);
      assert.equal(checkpoint.raw_object_count, batches);
      const copies = await env.DB.prepare("SELECT r2_key,size,sha256 FROM backup_raw_objects WHERE status='copied'").all<{ r2_key: string; size: number; sha256: string }>();
      assert.equal(copies.results.length, batches);
      for (const copy of copies.results) {
        const original = new Uint8Array(await (await env.RAW.get(copy.r2_key))!.arrayBuffer());
        const backup = new Uint8Array(await (await env.BACKUP!.get('raw/' + copy.r2_key))!.arrayBuffer());
        assert.deepEqual(backup, original);
        assert.equal(sha(backup), copy.sha256);
      }
      // Rows chunks hold only batches and their own events and versions.
      const rowsChunk = manifest.chunks.find(chunk => chunk.kind === 'rows')!;
      assert.deepEqual(Object.keys(rowsChunk.rows).sort(), ['batches', 'event_versions', 'events']);
      assert.ok(!(await objectText(env, rowsChunk.key)).includes('Synthetic content'));
    });
    await t.test('the restore check reloads the snapshot with triggers deferred and verifies every invariant', async () => {
      const report = await drill(env, checkpoint, migrations);
      assert.equal(report.result, 'passed', JSON.stringify(report.failures));
      assert.deepEqual(report.counts.tables, manifest.table_counts);
      // Without that track's migration the drill refuses the unknown table instead of dropping rows.
      assert.deepEqual((await drill(env, checkpoint)).failures, [{ code: 'unknown_table', count: 1 }]);
      assert.equal(report.counts.raw_objects, manifest.raw.objects);
      assert.ok(report.triggers.expected >= 20 && report.triggers.matched === report.triggers.expected);
      for (const check of ['manifest_sha256', 'chunk_sha256', 'raw_sha256', 'foreign_key_check', 'triggers_recreated', 'context_review_invariants',
        'context_revision_invariants', 'payload_rehash', 'device_identity', 'row_counts', 'project_drift']) assert.ok(report.checks.includes(check), check);
      for (const table of ['context_flags', 'context_flag_audit', 'context_shares', 'context_share_audit'])
        assert.ok(manifest.table_counts[table] >= 2, `${table} rows are part of the drill`);
      assert.deepEqual(report.findings, []);
      assert.equal(reportSha256(report), reportSha256(JSON.parse(JSON.stringify(report))));
      assert.ok(!JSON.stringify(report).includes(event.id) && !JSON.stringify(report).includes('Synthetic'));
    });
    await t.test('reviewer verification records an attestation only when counts match the manifest', async () => {
      const report = await drill(env, checkpoint, migrations);
      const body = verifyRequest(report);
      const wrong = { ...body, counts: { ...body.counts, tables: { ...body.counts.tables, devices: 99 } } };
      await assert.rejects(backupsWrite(post(`/api/backups/${checkpoint.id}/verify`, wrong), env, reviewer), (error: any) => error.status === 409);
      await assert.rejects(backupsWrite(post(`/api/backups/${checkpoint.id}/verify`, { ...body, extra: true }), env, reviewer), (error: any) => error.status === 400);
      const failed = await json(await backupsWrite(post(`/api/backups/${checkpoint.id}/verify`, { ...body, result: 'failed' }), env, reviewer));
      assert.equal(failed.checkpoint.status, 'completed');
      assert.equal(failed.checkpoint.verification_result, 'failed');
      const passed = await json(await backupsWrite(post(`/api/backups/${checkpoint.id}/verify`, body), env, reviewer));
      assert.equal(passed.checkpoint.status, 'verified');
      assert.equal(passed.checkpoint.retention_ready, true);
      assert.equal(passed.checkpoint.verification_sha256, body.report_sha256);
      await assert.rejects(backupsWrite(post(`/api/backups/${checkpoint.id}/verify`, body), env, reviewer), (error: any) => error.status === 409);
      const detail = await json(await backupsReviewerRead(get(`/api/backups/${checkpoint.id}`), env, reviewer));
      // The scheduled tick runs at a future scheduledTime here, so compare actions regardless of order.
      assert.deepEqual(detail.checkpoint.audit.map((row: any) => row.action).sort(), ['run', 'verify', 'verify']);
      assert.ok(detail.checkpoint.audit.every((row: any) => row.actor === reviewer || row.actor === 'maintenance:backup'));
      assert.ok(detail.checkpoint.chunks.length >= 3);
    });
    t.after(() => rm(migrations, { recursive: true, force: true }));
    await t.test('the object route serves only manifest members as attachments', async () => {
      const objectPath = (key: string) => get(`/api/backups/${checkpoint.id}/object?` + new URLSearchParams({ key }));
      const manifestResponse = (await backupsReviewerRead(objectPath(checkpoint.manifest_key!), env, reviewer))!;
      assert.equal(manifestResponse.headers.get('Content-Type'), 'application/octet-stream');
      assert.match(manifestResponse.headers.get('Content-Disposition')!, /^attachment/);
      assert.equal(sha(new Uint8Array(await manifestResponse.arrayBuffer())), checkpoint.manifest_sha256);
      const raw = (await env.DB.prepare('SELECT r2_key FROM batches LIMIT 1').first<{ r2_key: string }>())!.r2_key;
      assert.equal((await backupsReviewerRead(objectPath('raw/' + raw), env, reviewer))!.status, 200);
      assert.equal((await backupsReviewerRead(objectPath(manifest.chunks[0].key), env, reviewer))!.status, 200);
      const missing = 'raw/batches/mbp/runtime/' + '0'.repeat(64) + '.ndjson';
      await assert.rejects(backupsReviewerRead(objectPath(missing), env, reviewer), (error: any) => error.status === 404);
      await assert.rejects(backupsReviewerRead(objectPath(`checkpoints/${checkpoint.id}/d1/999999.ndjson`), env, reviewer), (error: any) => error.status === 404);
      for (const key of ['../raw/x', 'raw/../../secret', `checkpoints/${crypto.randomUUID()}/d1/000001.ndjson`, 'checkpoints/x/manifest.json', raw]) {
        await assert.rejects(backupsReviewerRead(objectPath(key), env, reviewer), (error: any) => error.status === 400, key);
      }
      await assert.rejects(backupsReviewerRead(get(`/api/backups/${checkpoint.id}/object?key=a&key=b`), env, reviewer), (error: any) => error.status === 400);
      await assert.rejects(backupsReviewerRead(get(`/api/backups/not-a-uuid`), env, reviewer), (error: any) => error.status === 400);
    });
  } finally { await fixture.close(); }
});

test('restore check reports drift, missing raw sources and tampering without trusting the manifest', async (t) => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env;
    await t.test('a session project upgrade between chunk rounds is drift, not failure', async () => {
      await fixture.ingest([syntheticEvent('drift-1', { session: 'drift', extra: { repository: undefined } })]);
      await backupTick(env, later(15), { chunkBatches: 1, maxSteps: 1 });
      assert.equal((await latestCheckpoint(env))!.chunk_count, 1);
      await fixture.ingest([syntheticEvent('drift-2', { session: 'drift' })]);
      const upgraded = (await fixture.event('drift-1'))!;
      assert.equal((await env.DB.prepare('SELECT identity_kind FROM projects WHERE id=?').bind(upgraded.project_id).first<any>()).identity_kind, 'remote');
      const checkpoint = await completeCheckpoint(env, later(15), { chunkBatches: 1 });
      const report = await drill(env, checkpoint);
      assert.equal(report.result, 'passed', JSON.stringify(report.failures));
      assert.deepEqual(report.findings, [{ code: 'event_project_drift', count: 1 }]);
    });
    await t.test('a raw object missing at copy time is recorded and fails the drill', async () => {
      await fixture.ingest([syntheticEvent('lost-1', { session: 'lost' })]);
      const lost = (await env.DB.prepare('SELECT b.id,b.r2_key FROM batches b JOIN events e ON e.batch_id=b.id WHERE e.event_id=?').bind('lost-1').first<any>());
      await env.RAW.delete(lost.r2_key);
      await env.DB.prepare('UPDATE backup_checkpoints SET started_at=? WHERE status!=?').bind('2000-01-01T00:00:00.000Z', 'running').run();
      const checkpoint = await completeCheckpoint(env, later(15));
      assert.equal((await env.DB.prepare('SELECT status FROM backup_raw_objects WHERE batch_id=?').bind(lost.id).first<any>()).status, 'source_missing');
      const report = await drill(env, checkpoint);
      assert.equal(report.result, 'failed');
      assert.deepEqual(report.failures, [{ code: 'raw_not_in_manifest', count: 1 }]);
    });
    const checkpoint = (await latestCheckpoint(env))!;
    const manifest = JSON.parse(await objectText(env, checkpoint.manifest_key!)) as Manifest;
    await t.test('changed chunks, raw copies and manifests are detected', async () => {
      const chunk = manifest.chunks.find(item => item.kind === 'final')!;
      const original = await objectText(env, chunk.key);
      await env.BACKUP!.put(chunk.key, original.replace('Synthetic MBP', 'Forged MBP!!'));
      assert.deepEqual((await drill(env, checkpoint)).failures, [{ code: 'chunk_sha256_mismatch', count: 1 }]);
      await env.BACKUP!.put(chunk.key, original);
      const rawList = manifest.chunks.find(item => item.kind === 'raw_list')!;
      const entry = JSON.parse((await objectText(env, rawList.key)).split('\n')[0]);
      const rawOriginal = await objectText(env, entry.key);
      await env.BACKUP!.put(entry.key, rawOriginal.replace('synthetic', 'tampered!'));
      assert.ok((await drill(env, checkpoint)).failures.some(failure => failure.code === 'raw_sha256_mismatch'));
      await env.BACKUP!.put(entry.key, rawOriginal);
      const wrongHash = await withDir(workDir => restoreCheck({ checkpointId: checkpoint.id, source: bucketSource(env.BACKUP!),
        expectedManifestSha256: 'f'.repeat(64), workDir }));
      assert.deepEqual(wrongHash.failures, [{ code: 'manifest_sha256_mismatch', count: 1 }]);
    });
    await t.test('manifest keys outside the fixed shapes are refused before anything is fetched', async () => {
      for (const key of ['../../outside.ndjson', `checkpoints/${checkpoint.id}/d1/../../x.ndjson`, `checkpoints/${crypto.randomUUID()}/d1/000001.ndjson`]) {
        const forged = { ...manifest, chunks: [{ ...manifest.chunks[0], key }] };
        const text = JSON.stringify(forged), fetched: string[] = [];
        const source = { async get(requested: string) { fetched.push(requested); return requested.endsWith('manifest.json') ? new TextEncoder().encode(text) : null; } };
        const report = await withDir(workDir => restoreCheck({ checkpointId: checkpoint.id, source, expectedManifestSha256: sha(text), workDir }));
        assert.deepEqual(report.failures, [{ code: 'invalid_manifest_key', count: 1 }]);
        assert.deepEqual(fetched, [checkpoint.manifest_key]);
      }
    });
    await t.test('the integrity pass flags an object changed after completion', async () => {
      await env.DB.prepare('UPDATE backup_checkpoints SET started_at=? WHERE status!=?').bind('2000-01-01T00:00:00.000Z', 'running').run();
      await fixture.ingest([syntheticEvent('integrity-1', { session: 'integrity' })]);
      await backupTick(env, later(15), { integrityPerTick: 0 });
      const fresh = (await latestCheckpoint(env))!;
      assert.equal(fresh.status, 'completed');
      assert.equal(fresh.integrity_verified_at, null);
      const freshManifest = JSON.parse(await objectText(env, fresh.manifest_key!)) as Manifest;
      const rawList = freshManifest.chunks.find(item => item.kind === 'raw_list')!;
      const entry = JSON.parse((await objectText(env, rawList.key)).split('\n').at(-2)!);
      await env.BACKUP!.put(entry.key, 'tampered');
      await backupTick(env, later(15));
      const after = (await env.DB.prepare('SELECT integrity_error,integrity_verified_at FROM backup_checkpoints WHERE id=?').bind(fresh.id).first<any>());
      assert.equal(after.integrity_error, 'raw_mismatch');
      assert.equal(after.integrity_verified_at, null);
    });
  } finally { await fixture.close(); }
});

test('checkpoint progress is leased, bounded and fails with codes', async (t) => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env;
    for (let index = 0; index < 5; index++) await fixture.ingest([syntheticEvent('bounded-' + index, { session: 'bounded-' + index })]);
    await t.test('a lease held by an overlapping invocation stops this one', async () => {
      const started = await json(await backupsWrite(post('/api/backups/run', {}), env, reviewer));
      assert.equal(started.checkpoint.status, 'running');
      assert.equal(started.scheduled, false);
      await assert.rejects(backupsWrite(post('/api/backups/run', {}), env, reviewer), (error: any) => error.status === 409);
      await env.DB.prepare('UPDATE backup_checkpoints SET lease_owner=?,lease_until=? WHERE id=?').bind('other', later(60).toISOString(), started.checkpoint.id).run();
      const tick = await backupTick(env, later(15), { chunkBatches: 2 });
      assert.deepEqual((tick.result as any).checkpoint, { id: started.checkpoint.id, leased_elsewhere: true });
      assert.equal((await latestCheckpoint(env))!.chunk_count, 0);
      await env.DB.prepare('UPDATE backup_checkpoints SET lease_until=? WHERE id=?').bind(later(-1).toISOString(), started.checkpoint.id).run();
      const resumed = await backupTick(env, later(15), { chunkBatches: 2, maxSteps: 1 });
      assert.equal((resumed.result as any).checkpoint.steps, 1);
      assert.equal((await latestCheckpoint(env))!.chunk_count, 1);
      assert.equal((await latestCheckpoint(env))!.lease_owner, null);
    });
    await t.test('per-tick budgets stop work early and the next tick resumes from the stored cursor', async () => {
      const allotment = { d1: 14, r2: 6, fetch: 0 };
      const before = (await latestCheckpoint(env))!.chunk_count;
      const tight = await runMaintenance({ ...env, MAINTENANCE_TASKS: 'backup' } as Env, { now: later(15), budgetMs: 120_000,
        tasks: [createBackupTask({ chunkBatches: 2, allotment })] });
      assert.equal(tight.backup.ok, true, JSON.stringify(tight.backup));
      assert.ok(tight.backup.usage.d1 <= allotment.d1 && tight.backup.usage.r2 <= allotment.r2);
      assert.equal((await latestCheckpoint(env))!.lease_owner, null);
      assert.ok((await latestCheckpoint(env))!.chunk_count >= before);
      const checkpoint = await completeCheckpoint(env, later(15), { chunkBatches: 2 });
      assert.equal(checkpoint.status, 'completed');
      assert.equal(checkpoint.raw_object_count, 5);
    });
    await t.test('a final snapshot over its cap fails the checkpoint with a code', async () => {
      await env.DB.prepare('UPDATE backup_checkpoints SET started_at=?').bind('2000-01-01T00:00:00.000Z').run();
      const tick = await backupTick(env, later(15), { finalMaxRows: 1 });
      assert.equal((tick.result as any).checkpoint.error, 'final_snapshot_too_large');
      const failed = (await latestCheckpoint(env))!;
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error_code, 'final_snapshot_too_large');
      // The next scheduled checkpoint waits for the interval rather than retrying every hour.
      const idle = await backupTick(env, later(15));
      assert.equal((idle.result as any).checkpoint, undefined);
    });
  } finally { await fixture.close(); }
});

test('expiry keeps the newest verified checkpoint and any a recent retention run relied on', async () => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env;
    await fixture.ingest([syntheticEvent('expire-1')]);
    const first = (await verifiedCheckpoint(env, later(15))).checkpoint;
    await env.DB.prepare('UPDATE backup_checkpoints SET started_at=?').bind('2000-01-01T00:00:00.000Z').run();
    await fixture.ingest([syntheticEvent('expire-2')]);
    const second = (await verifiedCheckpoint(env, later(16))).checkpoint;
    assert.notEqual(first.id, second.id);
    const expire = (id: string, now = new Date()) => expireCheckpoint(post(`/api/backups/${id}/expire`, {}), env, id, reviewer, now);
    await assert.rejects(expire(second.id), (error: any) => error.status === 409 && /newest verified/.test(error.message));
    await env.DB.prepare(`INSERT INTO retention_runs(id,data_class,plan_sha256,generated_at,cutoff,batch_count,event_count,version_count,raw_bytes,
      keys_sha256,checkpoint_id,actor,created_at) VALUES(?,'raw',?,?,?,1,0,0,0,?,?,?,?)`).bind(crypto.randomUUID(), 'a'.repeat(64), new Date().toISOString(),
      new Date().toISOString(), 'b'.repeat(64), first.id, reviewer, new Date().toISOString()).run();
    await assert.rejects(expire(first.id), (error: any) => error.status === 409 && /relied/.test(error.message));
    const manifest = JSON.parse(await objectText(env, first.manifest_key!)) as Manifest;
    const result = await json(await expire(first.id, later(31 * 24 * 60)));
    assert.equal(result.checkpoint.status, 'expired');
    assert.equal(result.objects_deleted, true);
    for (const chunk of manifest.chunks) assert.equal(await env.BACKUP!.get(chunk.key), null);
    assert.equal(await env.BACKUP!.get(first.manifest_key!), null);
    // Raw copies are shared by every checkpoint and stay.
    const raw = (await env.DB.prepare('SELECT r2_key FROM backup_raw_objects LIMIT 1').first<{ r2_key: string }>())!.r2_key;
    assert.ok(await env.BACKUP!.head('raw/' + raw));
    assert.equal((await json(await expire(first.id))).checkpoint.status, 'expired');
    await assert.rejects(env.DB.prepare("UPDATE backup_checkpoints SET status='verified' WHERE id=?").bind(first.id).run(), /backup_immutable/);
    await assert.rejects(backupsReviewerRead(get(`/api/backups/${first.id}/object?` + new URLSearchParams({ key: manifest.chunks[0].key })), env, reviewer),
      (error: any) => error.status === 404);
    const list = await json(await backupsReviewerRead(get('/api/backups?limit=1'), env, reviewer));
    assert.equal(list.checkpoints.length, 1);
    assert.equal(list.checkpoints[0].id, second.id);
    const next = await json(await backupsReviewerRead(get('/api/backups?limit=1&before=' + encodeURIComponent(list.next_cursor)), env, reviewer));
    assert.equal(next.checkpoints[0].id, first.id);
    assert.ok(!('lease_owner' in next.checkpoints[0]) && !('cursor' in next.checkpoints[0]));
    await assert.rejects(backupsReviewerRead(get('/api/backups?status=x'), env, reviewer), (error: any) => error.status === 400);
  } finally { await fixture.close(); }
});

test('restore-check CLI guards: private token file, safe URL, exclusive modes and offline directory drills', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-cli-'));
  try {
    const token = join(directory, 'token');
    await writeFile(token, 'synthetic-review-token-value-0000000000\n', { mode: 0o644 });
    await assert.rejects(readReviewToken(token), (error: any) => error instanceof RestoreError && error.code === 'token_file_not_private');
    await chmod(token, 0o600);
    assert.equal(await readReviewToken(token), 'synthetic-review-token-value-0000000000');
    await symlink(token, join(directory, 'link'));
    await assert.rejects(readReviewToken(join(directory, 'link')), (error: any) => error.code === 'token_file_not_regular');
    await assert.rejects(readReviewToken('relative/token'), (error: any) => error.code === 'token_file_not_absolute');
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'ftp://example.com'])
      assert.throws(() => workerUrl(url), (error: any) => error.code === 'invalid_url', url);
    assert.equal(workerUrl('https://beacon.example.invalid').origin, 'https://beacon.example.invalid');
    assert.equal(workerUrl('http://127.0.0.1:8787').port, '8787');
    const id = crypto.randomUUID();
    for (const argv of [[], ['--checkpoint', id], ['--checkpoint', 'x', '--dir', '/tmp/x'], ['--checkpoint', id, '--dir', 'relative'],
      ['--checkpoint', id, '--dir', '/tmp/x', '--url', 'https://x'], ['--checkpoint', id, '--url', 'https://x'], ['--checkpoint', id, '--dir', '/a', '--out', '/b'],
      ['--checkpoint', id, '--bogus', '1']]) assert.throws(() => parseArgs(argv), (error: any) => error.code === 'usage', argv.join(' '));
    assert.deepEqual(parseArgs(['--checkpoint', id, '--dir', '/tmp/x']), { checkpoint: id, dir: '/tmp/x' });
    // A local directory source reads only regular files under hash-derived names.
    await rm(join(directory, 'link'));
    const objects = join(directory, 'objects');
    const key = `checkpoints/${id}/manifest.json`;
    await writeFile(join(directory, 'placeholder'), 'x');
    const source = dirSource(directory);
    assert.equal(await source.get(key), null);
    await (await import('node:fs/promises')).mkdir(objects);
    await writeFile(join(objects, sha(key)), 'synthetic');
    assert.equal(new TextDecoder().decode((await source.get(key))!), 'synthetic');
    await symlink(token, join(objects, sha('other')));
    await assert.rejects(source.get('other'), (error: any) => error.code === 'invalid_local_object');
    assert.deepEqual((await readdir(objects)).sort(), [sha(key), sha('other')].sort());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the bundled Worker keeps every backup route behind review authority and runs the hourly tasks', async (t) => {
  const worker = await operationsWorker({ MAINTENANCE_TASKS: 'backup,health' });
  try {
    for (const id of ['worker-1', 'worker-2']) assert.equal((await worker.upload([syntheticEvent(id, { session: id })])).status, 200);
    const scheduled = await (await worker.mf.getWorker()).scheduled({ cron: '17 * * * *', scheduledTime: later(15) });
    assert.equal(scheduled.outcome, 'ok');
    const frequent = await (await worker.mf.getWorker()).scheduled({ cron: '*/15 * * * *', scheduledTime: later(15) });
    assert.equal(frequent.outcome, 'ok');
    const checkpoint = (await latestCheckpoint(worker.env))!;
    assert.equal(checkpoint.status, 'completed');
    assert.ok(checkpoint.integrity_verified_at);
    assert.ok((await worker.env.DB.prepare('SELECT last_pass FROM health_state WHERE id=1').first<any>()).last_pass);
    const objectPath = `/api/backups/${checkpoint.id}/object?` + new URLSearchParams({ key: checkpoint.manifest_key! });
    const reads = ['/api/backups', `/api/backups/${checkpoint.id}`, objectPath];
    await t.test('read, Access-only, MCP and device credentials cannot read or write backups', async () => {
      const denied = [
        {}, { Authorization: 'Bearer ' + operationsTokens.read }, { Authorization: 'Basic ' + btoa('beacon:' + operationsTokens.read) },
        { 'Cf-Access-Jwt-Assertion': 'synthetic.invalid.assertion' }, { Authorization: 'Bearer ' + operationsTokens.mcp },
        { Authorization: 'Bearer ' + operationsTokens.mbp },
      ];
      for (const headers of denied) {
        for (const path of reads) assert.ok([401, 403].includes((await worker.request(path, { headers })).status), path);
        for (const path of ['/api/backups/run', `/api/backups/${checkpoint.id}/verify`, `/api/backups/${checkpoint.id}/expire`,
          '/api/retention/apply', '/api/retention/policies']) {
          const response = await worker.request(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
          assert.ok([401, 403].includes(response.status), path);
        }
      }
      for (const path of reads) assert.equal((await worker.bearer(path, operationsTokens.review)).status, 200, path);
      const object = await worker.bearer(objectPath, operationsTokens.review);
      assert.equal(object.headers.get('Content-Type'), 'application/octet-stream');
      assert.match(object.headers.get('Content-Disposition')!, /^attachment/);
      assert.equal(object.headers.get('Cache-Control'), 'no-store');
      // The review credential is not a read credential.
      assert.equal((await worker.bearer('/api/health/data', operationsTokens.review)).status, 401);
      assert.equal((await worker.bearer('/api/health/data', operationsTokens.read)).status, 200);
      assert.equal((await worker.bearer('/api/retention/plan', operationsTokens.read)).status, 200);
      assert.equal((await worker.request('/api/backups/run', { method: 'POST', headers: { Authorization: 'Bearer ' + operationsTokens.review,
        'Content-Type': 'application/json', Origin: 'https://hostile.invalid' }, body: '{}' })).status, 403);
    });
    await t.test('the restore check downloads through the reviewer object route and refuses redirects', async () => {
      const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => worker.mf.dispatchFetch(String(input), init as never)) as unknown as typeof fetch;
      const source = httpSource(new URL('http://localhost'), operationsTokens.review, checkpoint.id, fetcher);
      const expected = await source.manifestSha256();
      assert.equal(expected, checkpoint.manifest_sha256);
      const workDir = await mkdtemp(join(tmpdir(), 'beacon-http-drill-'));
      try {
        const report = await restoreCheck({ checkpointId: checkpoint.id, source, expectedManifestSha256: expected, workDir });
        assert.equal(report.result, 'passed', JSON.stringify(report.failures));
        // The saved objects replay offline from the same directory layout.
        const offline = await withDir(offlineDir => restoreCheck({ checkpointId: checkpoint.id, source: dirSource(workDir), expectedManifestSha256: expected,
          workDir: offlineDir }));
        assert.equal(offline.result, 'passed');
        assert.equal(reportSha256(offline), reportSha256(report));
        // The CLI entry point runs the same offline drill and prints only the report and its hash.
        await writeFile(join(workDir, 'checkpoint.json'), JSON.stringify({ checkpoint_id: checkpoint.id, manifest_sha256: expected }), { mode: 0o600 });
        const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/restore-check.ts', '--dir', workDir, '--checkpoint', checkpoint.id]);
        const printed = JSON.parse(stdout);
        assert.equal(printed.report_sha256, reportSha256(report));
        assert.deepEqual(printed.verify_request, verifyRequest(report));
        const verified = await worker.write(`/api/backups/${checkpoint.id}/verify`, verifyRequest(report));
        assert.equal(verified.status, 200);
      } finally { await rm(workDir, { recursive: true, force: true }); }
      const redirecting = httpSource(new URL('http://localhost'), operationsTokens.review, checkpoint.id,
        (async () => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.invalid/' } })) as unknown as typeof fetch);
      await assert.rejects(redirecting.get('x'), (error: any) => error.code === 'redirect_rejected');
      const unauthorized = httpSource(new URL('http://localhost'), operationsTokens.read, checkpoint.id, fetcher);
      await assert.rejects(unauthorized.manifestSha256(), (error: any) => error.code === 'http_403');
    });
    await t.test('the CLI keeps --out private, removes its temporary directory and never prints the token', async () => {
      const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => worker.mf.dispatchFetch(String(input), init as never)) as unknown as typeof fetch;
      const directory = await mkdtemp(join(tmpdir(), 'beacon-cli-run-')), previous = process.env.TMPDIR;
      try {
        const tokenPath = join(directory, 'review-token'), out = join(directory, 'out'), scratch = join(directory, 'tmp');
        await writeFile(tokenPath, operationsTokens.review + '\n', { mode: 0o600 });
        await mkdir(scratch, { mode: 0o700 });
        const lines: string[] = [], errors: string[] = [];
        const io = { fetch: fetcher, log: (text: string) => lines.push(text), error: (text: string) => errors.push(text) };
        const remote = ['--url', 'http://localhost', '--review-token-file', tokenPath, '--checkpoint', checkpoint.id];
        assert.equal(await runCli([...remote, '--out', out], io), 0);
        assert.equal(JSON.parse(lines[0]).report.result, 'passed');
        assert.ok(['checkpoint.json', 'objects'].every(name => existsSync(join(out, name))));
        assert.equal((await stat(out)).mode & 0o777, 0o700);
        assert.equal(await runCli([...remote, '--out', out], io), 2);
        process.env.TMPDIR = scratch;
        assert.equal(await runCli(['--dir', out, '--checkpoint', checkpoint.id], io), 0);
        assert.deepEqual(await readdir(scratch), [], 'the temporary work directory is removed');
        await writeFile(tokenPath, operationsTokens.read + '\n', { mode: 0o600 });
        assert.equal(await runCli(remote, io), 2);
        assert.deepEqual(errors.map(text => JSON.parse(text).error), ['out_not_empty', 'http_403']);
        const printed = lines.concat(errors).join('\n');
        for (const secret of [operationsTokens.review, operationsTokens.read, tokenPath]) assert.ok(!printed.includes(secret));
      } finally {
        if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
        await rm(directory, { recursive: true, force: true });
      }
    });
  } finally { await worker.close(); }
});
