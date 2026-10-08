import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_BOOKKEEPING, BATCH_TABLES, LEDGER_TABLES, REVISED_TABLES, SNAPSHOT_TABLES } from '../src/operations-shared';
import { contextWrite } from '../src/context';
import { processingWrite } from '../src/processing';
import { planRequest } from '../src/processing-planner';
import { BACKUP_ALLOTMENT, Checkpoint, Manifest, backupTask, backupsReviewerRead, backupsWrite, createBackupTask, expireCheckpoint } from '../src/backup';
import { revisionsWrite } from '../src/context-revisions';
import { dataHealth } from '../src/health';
import { runMaintenance } from '../src/maintenance';
import { Env } from '../src/types';
import { RestoreError, bucketSource, dirSource, httpSource, parseArgs, readReviewToken, reportSha256, restoreCheck, runCli, verifyRequest, workerUrl }
  from '../scripts/restore-check';
import { createEnvFixture, migrationsExcept, syntheticEvent } from './env-fixture';
import { setPolicy as setProcessingPolicy, tick as processingTick, workspace } from './processing-helpers';
import { migrationStatements } from '../scripts/migration-sql';
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

test('backup reports a database without migration 0008 by code', async () => {
  const fixture = await createEnvFixture({ backup: true, migrations: await migrationsExcept('0008', '0009') });
  try {
    await fixture.ingest([syntheticEvent('schema-1')]);
    const report = await runMaintenance({ ...fixture.env, MAINTENANCE_TASKS: 'backup' } as Env, { tasks: [backupTask], now: later(20) });
    assert.equal(report.backup.error, 'backup_schema_missing');
    assert.equal((await fixture.env.BACKUP!.list()).objects.length, 0);
  } finally { await fixture.close(); }
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

test('each restore-drill consistency check fails on a backup that is internally consistent but wrong', async () => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env;
    const { migrations } = await seed(fixture);
    const checkpoint = await completeCheckpoint(env, later(15));
    assert.equal((await drill(env, checkpoint, migrations)).result, 'passed');
    type Line = { t: string; r: Record<string, any>; revision?: true };
    type Forged = { manifest: Manifest; lines: Map<string, any[]>; raw: Map<string, string> };
    const pristine: Forged = { manifest: JSON.parse(await objectText(env, checkpoint.manifest_key!)), lines: new Map(), raw: new Map() };
    for (const chunk of pristine.manifest.chunks) pristine.lines.set(chunk.key, (await objectText(env, chunk.key)).split('\n').filter(Boolean).map(text => JSON.parse(text)));
    // Rewrite the objects a mutation touched, with matching sizes and hashes all the way up to the manifest.
    const forged = async (mutate: (f: Forged) => void | Promise<void>, migrationsDirectory = migrations) => {
      const f: Forged = structuredClone(pristine);
      await mutate(f);
      const overlay = new Map<string, Uint8Array>();
      for (const [key, text] of f.raw) overlay.set(key, new TextEncoder().encode(text));
      for (const chunk of f.manifest.chunks) {
        const list = f.lines.get(chunk.key)!, body = new TextEncoder().encode(list.length ? list.map(item => JSON.stringify(item)).join('\n') + '\n' : '');
        Object.assign(chunk, { sha256: sha(body), bytes: body.byteLength });
        overlay.set(chunk.key, body);
      }
      const text = JSON.stringify(f.manifest);
      overlay.set(checkpoint.manifest_key!, new TextEncoder().encode(text));
      const backing = bucketSource(env.BACKUP!);
      const source = { get: async (key: string) => overlay.get(key) ?? backing.get(key) };
      const report = await withDir(workDir => restoreCheck({ checkpointId: checkpoint.id, source, expectedManifestSha256: sha(text), workDir, migrationsDirectory }));
      return report.failures.map(failure => failure.code).sort();
    };
    const rowsOf = (f: Forged) => f.manifest.chunks.filter(chunk => chunk.kind !== 'raw_list')
      .flatMap(chunk => f.lines.get(chunk.key)!.map((line: Line, index: number) => ({ chunk, line, index })));
    /** Remove matching rows, keeping every count consistent with what is left. */
    const remove = (f: Forged, table: string, match: (row: Record<string, any>) => boolean) => {
      let removed = 0;
      for (const chunk of f.manifest.chunks.filter(item => item.kind !== 'raw_list')) {
        const kept = f.lines.get(chunk.key)!.filter((line: Line) => !(line.t === table && !line.revision && match(line.r)));
        const gone = f.lines.get(chunk.key)!.length - kept.length;
        if (gone) { f.lines.set(chunk.key, kept); chunk.rows[table] -= gone; removed += gone; }
      }
      f.manifest.table_counts[table] -= removed;
      assert.ok(removed > 0, `nothing to remove from ${table}`);
    };
    const edit = (f: Forged, table: string, match: (row: Record<string, any>) => boolean, change: (row: Record<string, any>) => void) => {
      const found = rowsOf(f).filter(({ line }) => line.t === table && match(line.r));
      assert.ok(found.length, `nothing to edit in ${table}`);
      for (const { line } of found) change(line.r);
    };
    const superseded = rowsOf(pristine).find(({ line }) => line.t === 'context_entries' && line.r.status === 'superseded')!.line.r;
    const child = rowsOf(pristine).find(({ line }) => line.t === 'context_entries' && line.r.supersedes_id === superseded.id)!.line.r;
    const openFlag = rowsOf(pristine).find(({ line }) => line.t === 'context_flags' && line.r.status === 'open')!.line.r;
    const share = rowsOf(pristine).find(({ line }) => line.t === 'context_shares')!.line.r;
    const dismissedFlag = rowsOf(pristine).find(({ line }) => line.t === 'context_flags' && line.r.status === 'dismissed')!.line.r;
    const revokedShare = rowsOf(pristine).find(({ line }) => line.t === 'context_shares' && line.r.revoked_at)!.line.r;
    const version = rowsOf(pristine).find(({ line }) => line.t === 'event_versions')!.line.r;
    const batch = rowsOf(pristine).find(({ line }) => line.t === 'batches' && line.r.id === version.batch_id)!.line.r;
    const editedTriggers = await mkdtemp(join(tmpdir(), 'beacon-migrations-'));
    try {
      for (const name of await readdir(migrations)) await writeFile(join(editedTriggers, name), await readFile(join(migrations, name)));
      // SQLite stores CREATE TRIGGER without IF NOT EXISTS, so this trigger no longer matches its migration text.
      const file = join(editedTriggers, '0006_data_operations.sql');
      await writeFile(file, (await readFile(file, 'utf8')).replace('CREATE TRIGGER retention_runs_no_update', 'CREATE TRIGGER IF NOT EXISTS retention_runs_no_update'));
      const versions = rowsOf(pristine).filter(({ line }) => line.t === 'event_versions').map(({ line }) => line.r);
      const other = versions.find(row => row.batch_id !== version.batch_id)!;
      // Changes that break independent checks share one drill (each drill is a scratch Miniflare); every code is still asserted.
      const cases: [string[], (f: Forged) => void | Promise<void>, string?][] = [
        [['context_flag_audit_missing', 'context_flag_evidence_unresolved', 'context_review_audit_missing', 'context_share_audit_missing',
          'context_sources_count_invalid', 'context_supersede_invalid', 'payload_hash_mismatch', 'raw_line_missing', 'revision_without_row'], async (f) => {
          // A raw line that no longer re-hashes to its payload_hash, with its copy, list entry and hashes rewritten to match.
          const key = 'raw/' + batch.r2_key, lines = (await objectText(env, key)).split('\n');
          lines[version.line_number] = lines[version.line_number].replace('"timestamp"', '"timestamp_forged"');
          const text = lines.join('\n');
          f.raw.set(key, text);
          for (const chunk of f.manifest.chunks.filter(item => item.kind === 'raw_list'))
            for (const entry of f.lines.get(chunk.key)!) if (entry.key === key) Object.assign(entry, { size: new TextEncoder().encode(text).byteLength, sha256: sha(text) });
          edit(f, 'event_versions', row => row.event_id === other.event_id && row.payload_hash === other.payload_hash, row => { row.line_number = 99; });
          remove(f, 'context_audit', row => row.id === child.review_id);
          remove(f, 'context_audit', row => row.id === child.review_id + ':supersede');
          remove(f, 'context_sources', row => row.context_id === child.id);
          remove(f, 'context_flag_audit', row => row.id === openFlag.id + ':create');
          edit(f, 'context_flags', row => row.id === openFlag.id, row => { row.evidence = JSON.stringify([{ event_id: 'f'.repeat(64), payload_hash: 'f'.repeat(64) }]); });
          remove(f, 'context_share_audit', row => row.id === share.id + ':create');
          const chunk = f.manifest.chunks.find(item => item.kind === 'final')!;
          const session = rowsOf(f).find(({ line }) => line.t === 'sessions')!.line.r;
          f.lines.get(chunk.key)!.push({ t: 'sessions', r: { ...session, id: 'f'.repeat(64) }, revision: true });
          chunk.revisions = { ...chunk.revisions, sessions: (chunk.revisions?.sessions ?? 0) + 1 };
        }],
        // The closing arms on their own: a dismissed flag without its dismiss audit, a revoked share without its revoke audit.
        [['context_flag_audit_missing', 'context_share_audit_missing'], (f) => {
          remove(f, 'context_flag_audit', row => row.id === dismissedFlag.id + ':dismiss');
          remove(f, 'context_share_audit', row => row.id === revokedShare.id + ':revoke');
        }],
        // Count checks on the downloaded objects; the drill stops before loading when one fails.
        [['chunk_row_count_mismatch', 'raw_object_count_mismatch'], (f) => {
          f.manifest.raw.objects += 1;
          f.manifest.chunks.find(chunk => chunk.kind === 'final')!.rows.devices += 1;
        }],
        [['chunk_row_count_mismatch'], (f) => {
          const chunk = f.manifest.chunks.find(item => item.kind === 'final')!;
          chunk.revisions = { ...chunk.revisions, devices: (chunk.revisions?.devices ?? 0) + 1 };
        }],
        // Checks on the loaded database. SQLite stores CREATE TRIGGER without IF NOT EXISTS, so that
        // trigger no longer matches its migration text.
        [['device_token_digest_mismatch', 'row_count_mismatch', 'trigger_mismatch'], (f) => {
          f.manifest.table_counts.tasks = (f.manifest.table_counts.tasks ?? 0) + 1;
          f.manifest.table_counts.devices += 1;
        }, editedTriggers + '/'],
        // D1 enforces foreign keys while loading, so a dangling row stops its table from loading at all.
        [['context_flag_evidence_unresolved', 'context_sources_count_invalid', 'row_count_mismatch', 'row_load_failed'],
          (f) => remove(f, 'batches', row => row.id === batch.id)],
        // A duplicate key: the whole table is refused, so the review invariants that depend on it fail too.
        [['context_review_audit_missing', 'context_supersede_invalid', 'row_count_mismatch', 'row_load_failed'], (f) => {
          const { chunk, line } = rowsOf(f).find(({ line }) => line.t === 'context_audit')!;
          f.lines.get(chunk.key)!.push(structuredClone(line));
          chunk.rows.context_audit += 1; f.manifest.table_counts.context_audit += 1;
        }],
      ];
      for (const [codes, mutate, directory] of cases) assert.deepEqual(await forged(mutate, directory), codes, codes.join());
    } finally { await rm(editedTriggers, { recursive: true, force: true }); await rm(migrations, { recursive: true, force: true }); }
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

test('a raw source missing at copy time is copied once it reappears, so the next checkpoint restores it', async () => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env, start = later(15).getTime(), day = (n: number) => new Date(start + n * 25 * 3600_000);
    await fixture.ingest([syntheticEvent('kept-1', { session: 'kept' })]);
    const record = syntheticEvent('lost-1', { session: 'lost' }), lost = await fixture.ingest([record]);
    const key = (await env.DB.prepare('SELECT r2_key FROM batches WHERE id=?').bind(lost.batch_id).first<{ r2_key: string }>())!.r2_key;
    await env.RAW.delete(key);
    const first = await completeCheckpoint(env, day(0));
    const status = async () => (await env.DB.prepare('SELECT status,checked_at FROM backup_raw_objects WHERE batch_id=?').bind(lost.batch_id).first<any>());
    assert.equal((await status()).status, 'source_missing');
    assert.deepEqual((await drill(env, first)).failures, [{ code: 'raw_not_in_manifest', count: 1 }]);
    assert.ok((await dataHealth(env)).findings.some(item => item.code === 'backup_raw_source_missing'));
    // While the source is still gone each tick looks again and records when.
    const looked = await backupTick(env, day(0));
    assert.deepEqual([(looked.result as any).raw_missing_checked, (looked.result as any).raw_missing_recovered], [1, 0]);
    assert.equal((await status()).checked_at, day(0).toISOString());
    // The device resends the same batch: the same bytes restore the same key, and the index is unchanged.
    const resent = await fixture.ingest([record]);
    assert.deepEqual([resent.batch_id, resent.duplicate], [lost.batch_id, true]);
    const second = await completeCheckpoint(env, day(1));
    assert.equal((await status()).status, 'copied');
    assert.equal(second.raw_object_count, 2);
    const report = await drill(env, second);
    assert.equal(report.result, 'passed', JSON.stringify(report.failures));
    assert.ok(!(await dataHealth(env)).findings.some(item => item.code === 'backup_raw_source_missing'));
  } finally { await fixture.close(); }
});

test('the integrity pass verifies each shared raw copy once, checks the newest checkpoint first and keeps a share of every tick', async (t) => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env, start = later(15).getTime(), day = (n: number) => new Date(start + n * 25 * 3600_000);
    for (let index = 0; index < 5; index++) await fixture.ingest([syntheticEvent('shared-' + index, { session: 'shared-' + index })]);
    let heads = 0;
    const counting = { ...env, BACKUP: new Proxy(env.BACKUP!, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'head') return (...args: unknown[]) => { heads++; return (value as (...values: unknown[]) => unknown).apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    const verifiedCopies = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM backup_raw_objects WHERE status='copied' AND verified_at IS NOT NULL")
      .first<{ n: number }>())!.n;
    await t.test('a copy verified by one checkpoint is not checked again by the next', async () => {
      assert.ok((await completeCheckpoint(counting, day(0))).integrity_verified_at);
      assert.deepEqual([heads, await verifiedCopies()], [5, 5]);
      await fixture.ingest([syntheticEvent('shared-new', { session: 'shared-new' })]);
      heads = 0;
      const second = await completeCheckpoint(counting, day(1));
      assert.ok(second.integrity_verified_at);
      assert.equal(second.raw_object_count, 6);
      assert.deepEqual([heads, await verifiedCopies()], [1, 6], 'only the new copy is checked');
    });
    await t.test('the newest completed checkpoint is checked first', async () => {
      const unverified: Checkpoint[] = [];
      for (const n of [2, 3]) {
        await fixture.ingest([syntheticEvent('shared-day-' + n, { session: 'shared-day-' + n })]);
        await backupTick(env, day(n), { integrityPerTick: 0 });
        unverified.push((await latestCheckpoint(env))!);
      }
      assert.ok(unverified.every(cp => cp.status === 'completed' && !cp.integrity_cursor));
      await backupTick(env, day(3), { integrityPerTick: 1 });
      const [older, newer] = await Promise.all(unverified.map(cp => env.DB.prepare('SELECT * FROM backup_checkpoints WHERE id=?').bind(cp.id).first<Checkpoint>()));
      assert.equal(older!.integrity_cursor, null);
      assert.deepEqual(JSON.parse(newer!.integrity_cursor!), { stage: 'chunks', seq: 0 });
    });
    await t.test('a checkpoint with plenty of chunk work still leaves the integrity pass its share', async () => {
      for (let index = 0; index < 12; index++) await fixture.ingest([syntheticEvent('busy-' + index, { session: 'busy-' + index })]);
      const pending = (await env.DB.prepare(`SELECT * FROM backup_checkpoints WHERE integrity_verified_at IS NULL AND status='completed'
        ORDER BY completed_at DESC LIMIT 1`).first<Checkpoint>())!;
      const tick = await backupTick(env, day(4), { chunkBatches: 1, allotment: { d1: 60, r2: 2500, fetch: 0 } });
      assert.equal(tick.ok, true, JSON.stringify(tick));
      assert.equal((await latestCheckpoint(env))!.status, 'running', 'the new checkpoint is still chunking');
      const after = (await env.DB.prepare('SELECT * FROM backup_checkpoints WHERE id=?').bind(pending.id).first<Checkpoint>())!;
      assert.notEqual(after.integrity_cursor, pending.integrity_cursor, 'the integrity pass made progress');
    });
  } finally { await fixture.close(); }
});

test('the integrity pass reports every kind of change to a completed checkpoint', async () => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env, start = later(15).getTime(), day = (n: number) => new Date(start + n * 25 * 3600_000);
    const flip = (bytes: Uint8Array) => bytes.map((byte, index) => index === 0 ? byte ^ 0x01 : byte);
    const bytesOf = async (key: string) => new Uint8Array(await (await env.BACKUP!.get(key))!.arrayBuffer());
    await fixture.ingest([syntheticEvent('integrity-base')]);
    assert.ok((await completeCheckpoint(env, day(0))).integrity_verified_at);
    // Each case: a fresh checkpoint left unchecked, one change, then the next tick's verdict.
    const cases: [string, (cp: Checkpoint, manifest: Manifest, raw: { key: string; size: number; sha256: string }) => Promise<() => Promise<unknown>>][] = [
      ['manifest_missing', async (cp) => { await env.BACKUP!.delete(cp.manifest_key!); return async () => {}; }],
      ['manifest_mismatch', async (cp) => { await env.BACKUP!.put(cp.manifest_key!, flip(await bytesOf(cp.manifest_key!))); return async () => {}; }],
      ['chunk_missing', async (_cp, manifest) => { await env.BACKUP!.delete(manifest.chunks.find(chunk => chunk.kind !== 'raw_list')!.key); return async () => {}; }],
      // Same size, and R2 stores a checksum of the new bytes: only the recorded SHA-256 catches it.
      ['chunk_mismatch', async (_cp, manifest) => {
        const chunk = manifest.chunks.find(item => item.kind !== 'raw_list')!, changed = flip(await bytesOf(chunk.key));
        await env.BACKUP!.put(chunk.key, changed, { sha256: sha(changed) });
        return async () => {};
      }],
      ['raw_missing', async (_cp, _manifest, raw) => {
        const original = await bytesOf(raw.key);
        await env.BACKUP!.delete(raw.key);
        return () => env.BACKUP!.put(raw.key, original, { sha256: raw.sha256 });
      }],
      ['raw_mismatch', async (_cp, _manifest, raw) => {
        const original = await bytesOf(raw.key), changed = flip(original);
        await env.BACKUP!.put(raw.key, changed, { sha256: sha(changed) });
        return () => env.BACKUP!.put(raw.key, original, { sha256: raw.sha256 });
      }],
    ];
    for (const [index, [code, change]] of cases.entries()) {
      const { batch_id } = await fixture.ingest([syntheticEvent('integrity-' + code, { session: code })]);
      await backupTick(env, day(index + 1), { integrityPerTick: 0 });
      const cp = (await latestCheckpoint(env))!;
      assert.deepEqual([cp.status, cp.integrity_cursor], ['completed', null], code);
      const manifest = JSON.parse(await objectText(env, cp.manifest_key!)) as Manifest;
      // The copy of this case's new batch has not been verified by any earlier pass.
      const entries = (await objectText(env, manifest.chunks.find(chunk => chunk.kind === 'raw_list')!.key)).split('\n').filter(Boolean).map(text => JSON.parse(text));
      assert.equal((await env.DB.prepare('SELECT verified_at FROM backup_raw_objects WHERE batch_id=?').bind(batch_id).first<any>()).verified_at, null, code);
      const restore = await change(cp, manifest, entries.find(entry => entry.batch_id === batch_id));
      await backupTick(env, day(index + 1));
      const after = (await env.DB.prepare('SELECT integrity_error,integrity_verified_at FROM backup_checkpoints WHERE id=?').bind(cp.id).first<any>());
      assert.deepEqual([after.integrity_error, after.integrity_verified_at], [code, null], code);
      await restore();
    }
  } finally { await fixture.close(); }
});

test('every committed table has a backup export class that its schema supports', async () => {
  const statements = await migrationStatements();
  const created = statements.flatMap(statement => /^\s*CREATE TABLE\s+(\w+)/i.exec(statement.sql)?.[1] ?? []);
  const classes = [BATCH_TABLES, LEDGER_TABLES, Object.keys(REVISED_TABLES), SNAPSHOT_TABLES, [...BACKUP_BOOKKEEPING]].map(list => new Set<string>(list));
  for (const table of created) assert.equal(classes.filter(set => set.has(table)).length, 1, `${table} needs exactly one export class`);
  for (const set of classes) for (const table of set) assert.ok(created.includes(table), `${table} is classified but no migration creates it`);
  // A ledger round is exact only because nothing can change or delete an exported row.
  const forbids = (table: string, event: 'UPDATE' | 'DELETE') => statements.some(statement =>
    new RegExp(`^\\s*CREATE TRIGGER \\w+ BEFORE ${event} ON ${table}\\s+BEGIN\\s+SELECT RAISE\\(ABORT,'\\w+'\\);\\s+END;\\s*$`).test(statement.sql));
  for (const table of LEDGER_TABLES) for (const event of ['UPDATE', 'DELETE'] as const) assert.ok(forbids(table, event), `${table}: ${event} must be forbidden`);
  const fixture = await createEnvFixture({ backup: true });
  try {
    const rowless = (await fixture.env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%WITHOUT ROWID%'").all<{ name: string }>()).results;
    assert.deepEqual(rowless, [], 'round tables are exported by rowid');
    // Every query that finds possibly changed rows reaches them through an index, never a table scan.
    for (const [table, revised] of Object.entries(REVISED_TABLES)) for (const query of revised.touched) {
      const plan = await fixture.env.DB.prepare('EXPLAIN QUERY PLAN ' + query).bind('2026-01-01T00:00:00.000Z').all<{ detail: string }>();
      for (const step of plan.results) assert.doesNotMatch(step.detail, /^SCAN \w+$/, `${table}: ${step.detail}`);
    }
  } finally { await fixture.close(); }
});

test('tables that grow with activity are exported in rounds, so the final snapshot stays bounded by the small tables', async () => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env;
    // Events without a session id get one session each; processing adds a coverage and a source row per event.
    await fixture.ingest(Array.from({ length: 30 }, (_, index) => syntheticEvent('grow-' + index, { extra: { session: { working_directory: '/synthetic/alpha' } } })));
    await setProcessingPolicy(env, workspace);
    assert.equal((await processingTick(env, later(120))).ok, true);
    const live = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>())!.n;
    for (const table of ['sessions', 'processing_coverage', 'processing_job_sources']) assert.equal(await live(table), 30, table);
    const limits = { finalMaxRows: 40, tablePageRows: 7, tailRows: 5, revisionMarginMs: 0 };
    let finalLimits: number[] = [];
    const recording = { ...env, DB: new Proxy(env.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const wrap = (statement: any, args: unknown[]): any => new Proxy(statement, { get(object, key) {
          if (key === '__recorded') return { sql, args };
          if (key === 'bind') return (...values: unknown[]) => wrap(object.bind(...values), values);
          const value = object[key]; return typeof value === 'function' ? value.bind(object) : value;
        } });
        return wrap(target.prepare(sql), []);
      };
      if (property === 'batch') return (statements: any[]) => {
        const recorded = statements.map(statement => statement.__recorded as { sql: string; args: unknown[] });
        if (recorded.some(item => /^SELECT \* FROM "devices"/.test(item.sql))) finalLimits = recorded.map(item => Number(item.args.at(-1)));
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    const checkpoint = await completeCheckpoint(recording, later(180), limits);
    assert.deepEqual([checkpoint.status, checkpoint.error_code], ['completed', null]);
    // Every statement of the one-transaction snapshot has a limit, and together they stay within the budget.
    assert.ok(finalLimits.length > 3 && finalLimits.every(Number.isInteger));
    assert.ok(finalLimits.reduce((sum, value) => sum + value, 0) <= limits.finalMaxRows + finalLimits.length, finalLimits.join());
    const manifest = JSON.parse(await objectText(env, checkpoint.manifest_key!)) as Manifest;
    for (const table of Object.keys(manifest.table_counts)) assert.equal(manifest.table_counts[table], await live(table), table);
    const rounds = manifest.chunks.filter(chunk => chunk.kind === 'rows' && 'processing_coverage' in chunk.rows);
    assert.ok(rounds.length >= 4, 'processing_coverage went out in several pages');
    const final = manifest.chunks.filter(chunk => chunk.kind === 'final');
    assert.equal(final.reduce((sum, chunk) => sum + (chunk.rows.sessions ?? 0) + (chunk.rows.processing_coverage ?? 0), 0), 0);
    assert.ok(manifest.ledger_tables.includes('processing_coverage') && manifest.revised_tables.includes('sessions'));
    const report = await drill(env, checkpoint);
    assert.equal(report.result, 'passed', JSON.stringify(report.failures));
    // A reference table larger than the whole budget fails before anything is read into memory.
    await env.DB.prepare('UPDATE backup_checkpoints SET started_at=?').bind('2000-01-01T00:00:00.000Z').run();
    for (let index = 0; index < 50; index++) await env.DB.prepare(`INSERT INTO project_workflow_audit(id,actor,action,resource_type,resource_id,created_at)
      VALUES(?,?,?,?,?,?)`).bind(crypto.randomUUID(), reviewer, 'synthetic', 'task', 'synthetic', new Date().toISOString()).run();
    finalLimits = [];
    // Large tails: every round table fits the final snapshot, so only the reference tables decide.
    const failed = await completeCheckpoint(recording, later(181), { finalMaxRows: 40 });
    assert.deepEqual([failed.status, failed.error_code], ['failed', 'final_snapshot_too_large']);
    assert.deepEqual(finalLimits, [], 'the snapshot was refused from its upper bounds');
  } finally { await fixture.close(); }
});

test('rows that change after their round are re-read by the final snapshot, and rows added after it land in its tail', async () => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env, run = later(15);
    await fixture.ingest([syntheticEvent('revise-1', { session: 'revise', timestamp: '2026-10-08T00:00:00Z' })]);
    await fixture.ingest([syntheticEvent('revise-2', { session: 'revise-other' })]);
    const source = (await fixture.event('revise-1'))!;
    const base = { kind: 'memory', project_id: source.project_id, title: 'Synthetic revised', content: 'Synthetic only.',
      sources: [{ event_id: source.id, payload_hash: source.payload_hash }] };
    const parent = await createContext(env, base, 'approve');
    const child = await createContext(env, { ...base, title: 'Synthetic revision', supersedes_id: parent });
    const flag = ((await (await revisionsWrite(post(`/api/context/${parent}/flags`, { kind: 'needs_review', note: 'Synthetic' }), env, reviewer))!.json()) as any).flag.id;
    await setProcessingPolicy(env, workspace);
    const [scope] = (await planRequest(env, { project_id: source.project_id }, reviewer, new Date())).scopes;
    const job = scope.job_id!, call = crypto.randomUUID(), runId = crypto.randomUUID(), now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO processing_calls(id,job_id,provider,attempt,status,day,input_chars,estimated_tokens,started_at)
        VALUES(?,?,'jev',1,'reserved',?,10,10,?)`).bind(call, job, now.slice(0, 10), now),
      env.DB.prepare(`INSERT INTO retention_runs(id,data_class,plan_sha256,generated_at,cutoff,batch_count,event_count,version_count,raw_bytes,keys_sha256,
        checkpoint_id,actor,created_at) VALUES(?,'raw',?,?,?,1,0,0,0,?,?,?,?)`).bind(runId, 'a'.repeat(64), now, now, 'b'.repeat(64), crypto.randomUUID(), reviewer, now),
      // Its RAW object is already gone and its grace period far away, so the backup task leaves the row alone.
      env.DB.prepare(`INSERT INTO retention_run_objects(run_id,batch_id,r2_key,size,created_at,raw_deleted_at,backup_delete_after) VALUES(?,?,?,1,?,?,?)`)
        .bind(runId, 'c'.repeat(64), 'batches/mbp/runtime/' + 'c'.repeat(64) + '.ndjson', now, now, later(365 * 24 * 60).toISOString()),
    ]);
    // Every round (one per non-empty table) until only the final snapshot is left: an allotment of
    // 50 D1 calls covers rounds but never the final snapshot, which needs more than that.
    for (let index = 0; index < 20; index++) {
      const cp = await latestCheckpoint(env);
      const rounds = cp?.cursor ? JSON.parse(cp.cursor) : null;
      if (rounds && rounds.stage === rounds.order.length) break;
      await backupTick(env, run, { tailRows: 0, allotment: { d1: 50, r2: 2500, fetch: 0 } });
    }
    const pending = JSON.parse((await latestCheckpoint(env))!.cursor!);
    assert.equal(pending.stage, pending.order.length);
    assert.ok(['sessions', 'context_entries', 'context_flags', 'processing_jobs', 'processing_calls', 'retention_run_objects', 'context_audit']
      .every(table => pending.order.includes(table)));
    // Changes after every round: a review that supersedes a note, a resolved flag, a dismissed job, a finished
    // call, a recorded RAW deletion, a session that saw a newer event, and new ledger rows from a new note.
    const reviewed = await contextWrite(post(`/api/context/${child}/review`, { decision: 'approve' }), env, reviewer);
    assert.equal(reviewed!.status, 200);
    assert.equal((await revisionsWrite(post(`/api/context/flags/${flag}/resolve`, { resolution: 'resolved', reason: 'Synthetic' }), env, reviewer))!.status, 200);
    assert.equal((await processingWrite(post(`/api/processing/jobs/${job}/dismiss`, {}), env, reviewer))!.status, 200);
    await env.DB.batch([
      env.DB.prepare("UPDATE processing_calls SET status='succeeded',finished_at=? WHERE id=?").bind(new Date().toISOString(), call),
      env.DB.prepare('UPDATE retention_run_objects SET backup_deleted_at=? WHERE run_id=?').bind(new Date().toISOString(), runId),
    ]);
    await fixture.ingest([syntheticEvent('revise-3', { session: 'revise', timestamp: '2026-10-09T00:00:00Z' })]);
    await createContext(env, { ...base, kind: 'summary', title: 'Synthetic late note' });
    const checkpoint = await completeCheckpoint(env, run);
    assert.equal(checkpoint.status, 'completed');
    const manifest = JSON.parse(await objectText(env, checkpoint.manifest_key!)) as Manifest;
    const revised = manifest.chunks.reduce<Record<string, number>>((all, chunk) => {
      for (const [table, count] of Object.entries(chunk.revisions ?? {})) all[table] = (all[table] ?? 0) + count;
      return all;
    }, {});
    for (const table of ['sessions', 'context_entries', 'context_flags', 'processing_jobs', 'processing_calls', 'retention_run_objects'])
      assert.ok(revised[table] >= 1, `${table} rows were re-read`);
    const liveRow = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<Record<string, unknown>>();
    const checks: [string, unknown[]][] = [
      ['SELECT status,review_id FROM context_entries WHERE id=?', [parent]], ['SELECT status,review_id FROM context_entries WHERE id=?', [child]],
      ['SELECT status,resolved_at FROM context_flags WHERE id=?', [flag]], ['SELECT status,updated_at FROM processing_jobs WHERE id=?', [job]],
      ['SELECT status,finished_at FROM processing_calls WHERE id=?', [call]], ['SELECT backup_deleted_at FROM retention_run_objects WHERE run_id=?', [runId]],
      ["SELECT last_event_at FROM sessions WHERE id=(SELECT session_id FROM events WHERE event_id='revise-1')", []],
    ];
    const expected = await Promise.all(checks.map(([sql, args]) => liveRow(sql, ...args)));
    assert.deepEqual([expected[0]!.status, expected[1]!.status, expected[2]!.status, expected[3]!.status],
      ['superseded', 'approved', 'resolved', 'dismissed']);
    const report = await (async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'beacon-drill-'));
      try {
        return await restoreCheck({ checkpointId: checkpoint.id, source: bucketSource(env.BACKUP!), expectedManifestSha256: checkpoint.manifest_sha256!, workDir,
          inspect: async (db) => {
            for (const [index, [sql, args]] of checks.entries()) assert.deepEqual(await db.prepare(sql).bind(...args).first(), expected[index], sql);
          } });
      } finally { await rm(workDir, { recursive: true, force: true }); }
    })();
    assert.equal(report.result, 'passed', JSON.stringify(report.failures));
    for (const [table, count] of Object.entries(report.counts.tables))
      assert.equal(count, (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>())!.n, table);
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

test('the manifest step reserves every D1 call it makes, so a tick at the allotment edge stops cleanly', async () => {
  // Two fixtures in the same state: the first measures how many D1 calls a tick makes before the
  // manifest step, the second runs the same tick with exactly three calls left at that point.
  const prepared = async () => {
    const fixture = await createEnvFixture({ backup: true });
    // Every wrangler-migrated D1 has the migrations ledger, which the manifest step reads.
    await fixture.env.DB.batch([fixture.env.DB.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT)'),
      fixture.env.DB.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES('0001_initial.sql','2026-10-01T00:00:00Z')")]);
    await fixture.ingest([syntheticEvent('edge-1')]);
    for (let index = 0; index < 40 && (await latestCheckpoint(fixture.env))?.phase !== 'raw'; index++) await backupTick(fixture.env, later(15), { maxSteps: 1 });
    assert.equal((await latestCheckpoint(fixture.env))!.phase, 'raw');
    return fixture;
  };
  const measuring = await prepared(), edge = await prepared();
  try {
    let calls = 0, before = -1;
    const counted = new Proxy(measuring.env.DB, { get(target, property) {
      if (property === 'batch') return (statements: D1PreparedStatement[]) => {
        if (before < 0 && statements.length === 2 && /FROM backup_chunks WHERE checkpoint_id=\? ORDER BY seq/.test(String((statements[0] as any).__sql))) before = calls;
        calls += statements.length; return target.batch(statements);
      };
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql) as any;
        const wrap = (inner: any): any => new Proxy(inner, { get(object, key) {
          if (key === '__sql') return sql;
          if (key === 'bind') return (...values: unknown[]) => wrap(object.bind(...values));
          if (['first', 'all', 'run', 'raw'].includes(String(key))) return (...args: unknown[]) => { calls++; return object[key](...args); };
          const value = object[key]; return typeof value === 'function' ? value.bind(object) : value;
        } });
        return wrap(statement);
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const measured = await backupTick({ ...measuring.env, DB: counted } as Env, later(15));
    assert.equal((measured.result as any).checkpoint.status, 'completed');
    assert.ok(before > 0, 'the manifest step ran in the measured tick');
    const allotment = { ...BACKUP_ALLOTMENT, d1: before + 3 };
    const report = await runMaintenance({ ...edge.env, MAINTENANCE_TASKS: 'backup' } as Env, { now: later(15), budgetMs: 120_000,
      tasks: [createBackupTask({ allotment })] });
    assert.equal(report.backup.ok, true, JSON.stringify(report.backup));
    const stopped = (await latestCheckpoint(edge.env))!;
    assert.deepEqual([stopped.status, stopped.phase, stopped.lease_owner], ['running', 'manifest', null]);
    assert.equal((await completeCheckpoint(edge.env, later(15))).status, 'completed');
  } finally { await measuring.close(); await edge.close(); }
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
