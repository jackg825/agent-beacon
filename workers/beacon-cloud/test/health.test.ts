import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { HEALTH_ALLOTMENT, createHealthTask, dataHealth, healthRead, healthTask } from '../src/health';
import { runMaintenance } from '../src/maintenance';
import { MaintenanceError } from '../src/maintenance-error';
import { handleMcp } from '../src/mcp';
import { processingWrite } from '../src/processing';
import { planRequest } from '../src/processing-planner';
import { SelectionStage, ruleFilter } from '../src/processing-stage';
import { Env, HttpError } from '../src/types';
import { createEnvFixture, migrationsExcept, syntheticEvent } from './env-fixture';
import { applyMigrations } from './migrations';
import { revisionsWrite } from '../src/context-revisions';
import { createContext, get, later, post, reviewer, verifiedCheckpoint } from './operations-fixture';
import { job, setPolicy as setProcessingPolicy, staged, workspace } from './processing-helpers';

const HOUR = 3600_000, DAY = 24 * HOUR;
const codes = (health: Awaited<ReturnType<typeof dataHealth>>) => health.findings.map(finding => finding.code);
const finding = (health: Awaited<ReturnType<typeof dataHealth>>, code: string) => health.findings.find(item => item.code === code);
async function healthTick(env: Env, now: Date, listPage = 1000, maxPages = 1) {
  const report = await runMaintenance({ ...env, MAINTENANCE_TASKS: 'health' } as Env, { now, tasks: [createHealthTask({ listPage, maxPages })] });
  for (const kind of ['d1', 'r2', 'fetch'] as const) assert.ok(report.health.usage[kind] <= HEALTH_ALLOTMENT[kind]);
  return report.health;
}
async function pass(env: Env, now: Date, listPage = 1000, maxPages = 1) {
  for (let ticks = 1; ticks <= 50; ticks++) {
    const tick = await healthTick(env, now, listPage, maxPages);
    assert.equal(tick.ok, true, JSON.stringify(tick));
    if ((tick.result as any).pass_completed) return { ticks, state: JSON.parse((await env.DB.prepare('SELECT last_pass FROM health_state WHERE id=1').first<any>()).last_pass) };
  }
  throw new Error('List-diff pass did not complete');
}

test('health reports on any schema version and stays inert until opted in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-health-schema-'));
  const mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'storage'), workers: [{ name: 'health-schema', modules: true as const,
    script: 'export default {fetch(){return new Response("synthetic")}}', compatibilityDate: '2026-10-01', d1Databases: { DB: 'health-db' }, r2Buckets: { RAW: 'health-raw' } }] }));
  try {
    const env = { DB: await mf.getD1Database('DB'), RAW: await mf.getR2Bucket('RAW') } as unknown as Env;
    await applyMigrations(env.DB, ['0001_initial.sql', '0002_project_workflows.sql', '0003_context_reviews.sql']);
    await env.DB.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').bind('mbp', 'Synthetic MBP', 'a'.repeat(64), '2026-10-08T00:00:00Z').run();
    const health = await dataHealth(env);
    assert.deepEqual(health.schema, { data_operations: false, processing_jobs: false, context_flags: false });
    assert.deepEqual(codes(health), ['device_stale', 'backup_not_configured']);
    assert.deepEqual([health.processing, health.flags, health.retention], [{ available: false }, { available: false }, { available: false }]);
    assert.equal(health.capacity.approx_rows.devices, 1);
    assert.ok((health.capacity.d1_size_bytes ?? 0) > 0);
    assert.deepEqual(await runMaintenance(env, { tasks: [healthTask] }), {});
    const report = await runMaintenance({ ...env, MAINTENANCE_TASKS: 'health' } as Env, { tasks: [healthTask] });
    assert.equal(report.health.error, 'health_schema_missing');
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('the list-diff finds missing raw objects and orphans across bounded ticks', async (t) => {
  const fixture = await createEnvFixture();
  try {
    const env = fixture.env;
    for (let index = 0; index < 5; index++) await fixture.ingest([syntheticEvent('diff-' + index, { session: 'diff-' + index })]);
    const batches = (await env.DB.prepare('SELECT id,r2_key FROM batches ORDER BY r2_key').all<{ id: string; r2_key: string }>()).results;
    await env.RAW.delete(batches[2].r2_key);
    const strays = ['batches/aaa/runtime/' + '0'.repeat(64) + '.ndjson', 'batches/zzz/runtime/' + 'f'.repeat(64) + '.ndjson'];
    for (const key of strays) await env.RAW.put(key, 'synthetic stray');
    await env.RAW.put('elsewhere/not-a-batch', 'synthetic');
    await t.test('young unindexed objects and young index rows are in flight, not orphans or missing', async () => {
      const { ticks, state } = await pass(env, new Date(), 2);
      assert.ok(ticks >= 3);
      assert.deepEqual([state.listed, state.batches, state.missing.count, state.orphans.count], [6, 5, 0, 0]);
    });
    await t.test('after the grace window both directions are reported with identifiers only', async () => {
      const now = later(120);
      const { state } = await pass(env, now, 1000);
      assert.deepEqual(state.orphans.sample.sort(), strays);
      const health = await dataHealth(env, { now });
      assert.deepEqual(finding(health, 'raw_missing'), { code: 'raw_missing', severity: 'critical', count: 1, sample_ids: [batches[2].id],
        hint: finding(health, 'raw_missing')!.hint });
      assert.equal(finding(health, 'raw_orphan')!.count, 2);
      assert.equal(health.findings[0].severity, 'critical');
      assert.equal(health.capacity.raw_bytes, state.bytes);
      assert.ok(!codes(health).includes('raw_scan_stale'));
    });
    await t.test('one tick diffs as many pages as its allotment allows', async () => {
      const { ticks, state } = await pass(env, later(120), 2, 50);
      assert.equal(ticks, 1);
      assert.deepEqual([state.listed, state.batches, state.missing.count, state.orphans.count], [6, 5, 1, 2]);
      assert.ok(state.ticks === 1);
    });
    await t.test('when R2 is empty the index side stays bounded per page', async () => {
      for (const batch of batches) await env.RAW.delete(batch.r2_key);
      const { ticks, state } = await pass(env, later(120), 2);
      assert.equal(state.missing.count, 5);
      assert.ok(ticks >= 3, 'two index rows per tick');
    });
  } finally { await fixture.close(); }
});

test('a batch uploaded between the R2 listing and the index read is in flight, not missing', async () => {
  const fixture = await createEnvFixture();
  try {
    const env = fixture.env;
    await fixture.ingest([syntheticEvent('settled-1')]);
    let uploaded = false;
    // A device's ingest writes R2 and commits D1 after the listing snapshot but before the range read.
    const racing = { ...env, RAW: new Proxy(env.RAW, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'list') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const listing = await (value as (...values: unknown[]) => Promise<unknown>).apply(target, args);
        if (!uploaded) { uploaded = true; await fixture.ingest([syntheticEvent('racing-1', { session: 'racing' })]); }
        return listing;
      };
    } }) } as Env;
    const tick = await healthTick(racing, new Date());
    assert.ok(uploaded);
    assert.deepEqual([(tick.result as any).pass_completed, (tick.result as any).indexed, (tick.result as any).missing], [true, 2, 0]);
    assert.equal(finding(await dataHealth(env), 'raw_missing'), undefined);
  } finally { await fixture.close(); }
});

test('overlapping health ticks never double count a page', async () => {
  const fixture = await createEnvFixture();
  try {
    const env = fixture.env;
    await fixture.ingest([syntheticEvent('overlap-1')]);
    let waiting: (() => void)[] = [];
    const barrier = { ...env, RAW: new Proxy(env.RAW, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'list') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        // Both invocations have read health_state before either lists, as with two overlapping crons.
        await new Promise<void>(resolve => { waiting.push(resolve); if (waiting.length === 2) waiting.forEach(release => release()); });
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    } }) } as Env;
    const [one, two] = await Promise.all([healthTick(barrier, new Date()), healthTick(barrier, new Date())]);
    assert.deepEqual([one.result, two.result].filter(result => (result as any).conflict), [{ conflict: true }]);
    const state = JSON.parse((await env.DB.prepare('SELECT last_pass FROM health_state WHERE id=1').first<any>()).last_pass);
    assert.equal(state.listed, 1);
    waiting = [];
  } finally { await fixture.close(); }
});

test('findings cover devices, backlog, stale notes, flags and backups without content', async (t) => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env, now = new Date();
    const recent = new Date(now.getTime() - 60_000).toISOString(), old = new Date(now.getTime() - 5 * HOUR).toISOString();
    await fixture.ingest([syntheticEvent('fresh-1', { timestamp: recent, extra: { message: 'synthetic-secret-marker' } })]);
    await fixture.ingest([syntheticEvent('late-1', { session: 'late', timestamp: old })], 'mini');
    await t.test('device liveness and ingest backlog', async () => {
      const health = await dataHealth(env, { now });
      const mini = health.devices.find(device => device.id === 'mini')!;
      assert.ok(mini.lag_seconds!.median >= 5 * 3600 - 120);
      assert.equal(health.devices.find(device => device.id === 'mbp')!.lag_seconds!.max < 600, true);
      assert.deepEqual(finding(health, 'ingest_backlog')!.sample_ids, ['mini']);
      assert.equal(finding(health, 'device_stale'), undefined);
      const quiet = await dataHealth(env, { now: new Date(now.getTime() + 3 * DAY) });
      assert.deepEqual(finding(quiet, 'device_stale')!.sample_ids.sort(), ['mbp', 'mini']);
      await env.DB.prepare('UPDATE devices SET revoked=1 WHERE id=?').bind('mini').run();
      assert.deepEqual(finding(await dataHealth(env, { now: new Date(now.getTime() + 3 * DAY) }), 'device_stale')!.sample_ids, ['mbp']);
      await env.DB.prepare('UPDATE devices SET revoked=0 WHERE id=?').bind('mini').run();
    });
    await t.test('approved notes whose sources moved scope or whose project moved on', async () => {
      await fixture.ingest([syntheticEvent('stale-1', { session: 'stale', timestamp: recent, extra: { repository: undefined } })]);
      const source = (await fixture.event('stale-1'))!;
      const note = await createContext(env, { kind: 'memory', project_id: source.project_id, title: 'Synthetic stale title', content: 'Synthetic stale content.',
        sources: [{ event_id: source.id, payload_hash: source.payload_hash }] }, 'approve');
      const fresh = (await fixture.event('fresh-1'))!;
      const aging = await createContext(env, { kind: 'memory', project_id: fresh.project_id, title: 'Synthetic aging title', content: 'Synthetic aging content.',
        sources: [{ event_id: fresh.id, payload_hash: fresh.payload_hash }] }, 'approve');
      assert.equal(finding(await dataHealth(env, { now }), 'context_sources_invalid'), undefined);
      // The same session later reports its repository: the session and its events move to the remote project.
      await fixture.ingest([syntheticEvent('stale-2', { session: 'stale', timestamp: recent })]);
      assert.deepEqual(finding(await dataHealth(env, { now }), 'context_sources_invalid')!.sample_ids, [note]);
      await fixture.ingest([syntheticEvent('newer-1', { timestamp: new Date(now.getTime() + DAY).toISOString() })]);
      const month = await dataHealth(env, { now: new Date(now.getTime() + 31 * DAY) });
      assert.deepEqual(finding(month, 'context_aging')!.sample_ids, [aging]);
      const text = JSON.stringify(month);
      for (const secret of ['synthetic-secret-marker', 'Synthetic stale', 'Synthetic aging', '/synthetic/']) assert.ok(!text.includes(secret), secret);
    });
    await t.test("open flags are counted from Track R's table and leave the report once a reviewer closes them", async () => {
      let health = await dataHealth(env, { now });
      assert.deepEqual([health.schema.context_flags, health.flags], [true, { available: true, open: 0 }]);
      assert.equal(finding(health, 'open_flags'), undefined);
      const fresh = (await fixture.event('fresh-1'))!;
      const note = await createContext(env, { kind: 'memory', project_id: fresh.project_id, title: 'Synthetic flagged title',
        content: 'Synthetic flagged content.', sources: [{ event_id: fresh.id, payload_hash: fresh.payload_hash }] }, 'approve');
      const flag = async () => {
        const response = await revisionsWrite(post(`/api/context/${note}/flags`, { kind: 'needs_review', note: 'synthetic-secret-marker' }), env, reviewer);
        assert.equal(response!.status, 201);
        return ((await response!.json()) as any).flag.id as string;
      };
      const [open, closed] = [await flag(), await flag()];
      assert.equal((await revisionsWrite(post(`/api/context/flags/${closed}/resolve`, { resolution: 'dismissed', reason: 'Synthetic' }), env, reviewer))!.status, 200);
      health = await dataHealth(env, { now });
      assert.deepEqual(health.flags, { available: true, open: 1 });
      assert.deepEqual(finding(health, 'open_flags')!.sample_ids, [open]);
      assert.ok(!JSON.stringify(health).includes('synthetic-secret-marker'));
      // The rows stay for the backup subtest below, whose restore drill reloads them.
    });
    await t.test('backup configuration, freshness, verification and raw copy lag', async () => {
      const unbound = await dataHealth({ ...env, BACKUP: undefined } as Env, { now });
      assert.ok(codes(unbound).includes('backup_not_configured'));
      assert.ok(codes(await dataHealth(env, { now })).includes('backup_not_scheduled'));
      const scheduled = { ...env, MAINTENANCE_TASKS: 'backup,health' } as Env;
      const before = await dataHealth(scheduled, { now: new Date(now.getTime() + 3 * HOUR) });
      assert.ok(['backup_stale', 'backup_unverified', 'backup_raw_lag', 'raw_scan_stale'].every(code => codes(before).includes(code)), codes(before).join());
      await verifiedCheckpoint(env, later(15));
      const after = await dataHealth(scheduled, { now: later(16) });
      for (const code of ['backup_stale', 'backup_unverified', 'backup_raw_lag', 'backup_not_scheduled']) assert.ok(!codes(after).includes(code), code);
      assert.equal((after.backup as any).retention_ready.id, (await env.DB.prepare('SELECT id FROM backup_checkpoints').first<any>()).id);
      await env.DB.prepare("UPDATE backup_checkpoints SET integrity_error='raw_mismatch'").run();
      await env.DB.prepare(`INSERT INTO backup_checkpoints(id,status,phase,started_at,started_by,error_code,updated_at)
        VALUES(?,'failed','chunks',?,'maintenance:backup','final_snapshot_too_large',?)`).bind(crypto.randomUUID(), later(20).toISOString(), later(20).toISOString()).run();
      await env.DB.prepare(`INSERT INTO backup_raw_objects(batch_id,r2_key,batch_received_at,status,copied_at) VALUES(?,?,?,'source_missing',?)`)
        .bind('c'.repeat(64), 'batches/mbp/runtime/' + 'c'.repeat(64) + '.ndjson', recent, recent).run();
      const broken = await dataHealth(scheduled, { now: later(21) });
      assert.deepEqual(broken.findings.slice(0, 2).map(item => item.code).sort(), ['backup_integrity_failed', 'backup_raw_source_missing']);
      assert.ok(codes(broken).includes('backup_failed'));
    });
    await t.test('exact counts only on request, and the read route validates its filter', async () => {
      const approx = await dataHealth(env, { now });
      assert.equal('exact_rows' in approx.capacity, false);
      const exact = (await (await healthRead(get('/api/health/data?exact=1'), env))!.json()) as any;
      const events = (await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())!.n;
      assert.equal(exact.capacity.exact_rows.events, events);
      assert.ok(exact.capacity.approx_rows.events >= events);
      for (const query of ['?exact=2', '?exact=1&exact=1', '?other=1'])
        await assert.rejects(healthRead(get('/api/health/data' + query), env), (error: unknown) => error instanceof HttpError && error.status === 400);
      assert.equal(await healthRead(get('/api/health/other'), env), null);
    });
    await t.test('the read-only MCP tool returns the same report', async () => {
      const endpoint = new URL('https://beacon.example.invalid/mcp');
      const client = new Client({ name: 'synthetic-health-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      try {
        await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch: (input, init) => handleMcp(new Request(input, init), env) }));
        const tool = (await client.listTools()).tools.find(item => item.name === 'beacon_get_data_health')!;
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
        const result = await client.callTool({ name: 'beacon_get_data_health', arguments: {} });
        assert.equal(result.isError, undefined);
        assert.ok(Array.isArray((result.structuredContent as any).findings));
        assert.ok(!JSON.stringify(result).includes('synthetic-secret-marker'));
      } finally { await client.close(); }
    });
  } finally { await fixture.close(); }
});

test('without migration 0004 the processing queue is unavailable, and a foreign table layout degrades to a code', async () => {
  // Explicitly the schema of a deployment that applied Track D but never Track P (nor Track R, whose flags build on it).
  const fixture = await createEnvFixture({ migrations: await migrationsExcept('0004', '0007') });
  try {
    const env = fixture.env;
    let health = await dataHealth(env);
    assert.deepEqual(health.schema, { data_operations: true, processing_jobs: false, context_flags: false });
    assert.deepEqual(health.processing, { available: false });
    assert.ok(!codes(health).some(code => code.startsWith('processing_')));
    assert.equal((await healthTick(env, new Date())).ok, true);
    // A table of that name with another layout is reported as a code; the rest of the report stands.
    await env.DB.prepare('CREATE TABLE processing_jobs(id TEXT PRIMARY KEY, state TEXT)').run();
    health = await dataHealth(env);
    assert.deepEqual(health.processing, { available: true, error: 'query_failed' });
    assert.equal(health.devices.length, 2);
  } finally { await fixture.close(); }
});

test('health counts the real processing queue: planned, leased, failed, retried and dismissed jobs', async () => {
  const fixture = await createEnvFixture();
  try {
    const env = fixture.env, now = new Date(), before = (hours: number) => new Date(now.getTime() - hours * HOUR);
    const empty = await dataHealth(env, { now });
    assert.equal(empty.schema.processing_jobs, true);
    assert.deepEqual(empty.processing, { available: true, queued: 0, running: 0, failed: 0, oldest_queued_at: null, oldest_due_at: null });
    await setProcessingPolicy(env, workspace);
    const projects: Record<string, string> = {};
    for (const name of ['failing', 'leased', 'waiting']) {
      await fixture.ingest([syntheticEvent('queue-' + name, { repo: 'queue-' + name, session: 'queue-' + name })]);
      projects[name] = (await fixture.event('queue-' + name))!.project_id;
    }
    // Planned by Track P's own planner at fixed past times, as the scheduler would have.
    const plan = async (name: string, at: Date) => (await planRequest(env, { project_id: projects[name] }, reviewer, at)).scopes[0].job_id!;
    const failing = await plan('failing', before(9)), leased = await plan('leased', before(8)), waiting = await plan('waiting', before(7));
    // Track P's runner: every attempt at the failing job errors until backoff ends in failed, and
    // the invocation that claims the leased job runs out of allotment mid-job, leaving its lease.
    const stage: SelectionStage = async (input) => {
      if (input.scope.project_id === projects.leased) throw new MaintenanceError('budget_exhausted:d1');
      if (input.scope.project_id === projects.failing) throw new Error('synthetic stage failure');
      return ruleFilter(input);
    };
    const tick = (at: Date) => runMaintenance({ ...env, MAINTENANCE_TASKS: 'processing' } as Env, { now: at, schedule: 'frequent', tasks: staged(stage) });
    for (const minutes of [0, 1, 6, 36]) await tick(new Date(before(9).getTime() + minutes * 60_000));
    assert.equal((await tick(before(8))).processing.error, 'budget_exhausted:d1');
    assert.deepEqual([(await job(env, failing)).status, (await job(env, leased)).status, (await job(env, waiting)).status], ['failed', 'running', 'queued']);
    const health = await dataHealth(env, { now });
    assert.deepEqual(health.processing, { available: true, queued: 1, running: 1, failed: 1, oldest_queued_at: before(7).toISOString(),
      oldest_due_at: before(7).toISOString() });
    assert.deepEqual([finding(health, 'processing_failed')!.count, finding(health, 'processing_queue_stale')!.count], [1, 1]);
    // A reviewer retries the failed job and dismisses the waiting one through Track P's routes.
    for (const [id, action] of [[failing, 'retry'], [waiting, 'dismiss']])
      assert.equal((await processingWrite(post(`/api/processing/jobs/${id}/${action}`, {}), env, reviewer))!.status, 200);
    const after = await dataHealth(env, { now });
    const { oldest_due_at: due, ...queue } = after.processing as Record<string, unknown>;
    assert.deepEqual(queue, { available: true, queued: 1, running: 1, failed: 0, oldest_queued_at: before(9).toISOString() });
    assert.ok(Date.parse(due as string) >= now.getTime(), 'a retried job is due from the retry, not from its plan time');
    for (const code of ['processing_failed', 'processing_queue_stale']) assert.equal(finding(after, code), undefined, code);
  } finally { await fixture.close(); }
});

test('the scheduled health task never counts the large tables and stays within its allotment', async () => {
  const fixture = await createEnvFixture();
  try {
    for (let index = 0; index < 3; index++) await fixture.ingest([syntheticEvent('discipline-' + index, { session: 'discipline-' + index })]);
    const statements: string[] = [];
    const db = new Proxy(fixture.env.DB, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'prepare') return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const report = await runMaintenance({ ...fixture.env, DB: db, MAINTENANCE_TASKS: 'health' } as Env, { tasks: [healthTask], schedule: 'hourly' });
    assert.equal(report.health.ok, true);
    assert.ok(report.health.usage.d1 <= 3 && report.health.usage.r2 === 1);
    assert.ok(statements.length > 0);
    for (const sql of statements) assert.doesNotMatch(sql, /COUNT\s*\(\s*\*\s*\)[\s\S]*\b(events|event_versions|batches)\b/i);
    assert.ok(statements.some(sql => /r2_key>\? AND r2_key<=\?/.test(sql)), 'uses the r2_key index range');
  } finally { await fixture.close(); }
});
