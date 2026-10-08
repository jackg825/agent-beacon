import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { INVOCATION_LIMITS, MaintenanceError, MaintenanceTask, maintenanceTasks, runMaintenance } from '../src/maintenance';
import { HttpError, Env } from '../src/types';
import { applyMigrations } from './migrations';

const allotment = { d1: 50, r2: 50, fetch: 2 };
const all = (names: string[]) => ({ MAINTENANCE_TASKS: names.join(',') }) as Env;
const task = (name: string, run: MaintenanceTask['run'], schedule: MaintenanceTask['schedule'] = 'frequent'): MaintenanceTask =>
  ({ name, schedule, allotment, run });

test('maintenance isolates task failures, reports only codes and shares one deadline', async () => {
  let now = 0;
  const clock = () => now;
  const ran: string[] = [];
  const names = ['first', 'coded', 'http', 'leaky', 'slow', 'late'];
  const report = await runMaintenance(all(names), { clock, budgetMs: 100, tasks: [
    task('first', async () => { ran.push('first'); now += 10; return { planned: 2 }; }),
    task('coded', async () => { ran.push('coded'); throw new MaintenanceError('backup_not_configured'); }),
    task('http', async () => { ran.push('http'); throw new HttpError(503, 'Raw batch unavailable'); }),
    task('leaky', async () => { ran.push('leaky'); throw new Error('D1_ERROR: SELECT secret FROM devices'); }),
    task('slow', async (_env, ctx) => { ran.push('slow'); assert.equal(ctx.remaining(), 90); now += 200; return {}; }),
    task('late', async () => { ran.push('late'); return {}; }),
  ] });
  assert.deepEqual(ran, ['first', 'coded', 'http', 'leaky', 'slow']);
  assert.deepEqual(report.first, { ok: true, duration_ms: 10, usage: { d1: 0, r2: 0, fetch: 0 }, result: { planned: 2 } });
  assert.equal(report.coded.error, 'backup_not_configured');
  assert.equal(report.http.error, 'http_503');
  assert.equal(report.leaky.error, 'task_failed');
  assert.ok(!JSON.stringify(report).includes('secret'));
  assert.deepEqual(report.late, { ok: false, duration_ms: 0, usage: { d1: 0, r2: 0, fetch: 0 }, error: 'budget_exhausted:time' });
});

test('nothing runs unless named in MAINTENANCE_TASKS, and schedules select their own tasks', async () => {
  const ran: string[] = [];
  const tasks = [task('processing', async () => { ran.push('processing'); return {}; }),
    task('backup', async () => { ran.push('backup'); return {}; }, 'hourly')];
  assert.deepEqual(await runMaintenance({} as Env, { tasks }), {});
  const unknown = { ok: false, duration_ms: 0, usage: { d1: 0, r2: 0, fetch: 0 }, error: 'unknown_task' };
  assert.deepEqual(await runMaintenance({ MAINTENANCE_TASKS: ' , unknown ' } as Env, { tasks }), { unknown });
  // A name that is not even well formed is reported without echoing it.
  assert.deepEqual(await runMaintenance({ MAINTENANCE_TASKS: 'processing,<script>' } as Env, { tasks, schedule: 'hourly' }),
    { invalid_task_name: unknown });
  await runMaintenance(all(['processing', 'backup']), { tasks, schedule: 'hourly' });
  await runMaintenance(all(['processing', 'backup']), { tasks, schedule: 'frequent' });
  assert.deepEqual(ran, ['backup', 'processing']);
});

test('maintenance rejects out-of-range configured budgets and honours valid ones', async () => {
  let now = 0;
  const seen: number[] = [];
  const probe = [task('probe', async (_env, ctx) => { seen.push(ctx.remaining()); return {}; })];
  for (const value of ['5', 'abc', '700000', '2500']) {
    await runMaintenance({ MAINTENANCE_TASKS: 'probe', MAINTENANCE_BUDGET_MS: value } as Env, { clock: () => now, tasks: probe });
  }
  assert.deepEqual(seen, [25_000, 25_000, 25_000, 2_500]);
});

test('the metered env enforces each allotment on D1 statements, batches, R2 calls and fetches', async () => {
  const { createEnvFixture } = await import('./env-fixture');
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = { ...fixture.env, MAINTENANCE_TASKS: 'd1,r2,fetch,shared' } as Env;
    const fetched: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => { fetched.push(String(input)); return new Response('{}'); }) as typeof fetch;
    const report = await runMaintenance(env, { fetcher, tasks: [
      { name: 'd1', schedule: 'frequent', allotment: { d1: 4, r2: 0, fetch: 0 }, async run(metered) {
        const statement = metered.DB.prepare('SELECT COUNT(*) AS n FROM devices');
        assert.equal((await statement.first<{ n: number }>())!.n, 2);
        assert.equal((await metered.DB.prepare('SELECT id FROM devices WHERE id=?').bind('mbp').all()).results.length, 1);
        await metered.DB.batch([metered.DB.prepare('SELECT 1'), metered.DB.prepare('SELECT 2')]);
        await metered.DB.prepare('SELECT 3').first();
        return {};
      } },
      { name: 'r2', schedule: 'frequent', allotment: { d1: 0, r2: 2, fetch: 0 }, async run(metered) {
        await metered.RAW.put('synthetic/key', 'synthetic');
        assert.equal(await (await metered.BACKUP!.get('synthetic/missing')), null);
        await metered.RAW.head('synthetic/key');
        return {};
      } },
      { name: 'fetch', schedule: 'frequent', allotment: { d1: 0, r2: 0, fetch: 1 }, async run(_metered, ctx) {
        await ctx.fetch('https://provider.invalid/one');
        await ctx.fetch('https://provider.invalid/two');
        return {};
      } },
    ] });
    assert.equal(report.d1.error, 'budget_exhausted:d1');
    assert.deepEqual(report.d1.usage, { d1: 4, r2: 0, fetch: 0 });
    assert.equal(report.r2.error, 'budget_exhausted:r2');
    assert.deepEqual(report.r2.usage, { d1: 0, r2: 2, fetch: 0 });
    assert.equal(report.fetch.error, 'budget_exhausted:fetch');
    assert.deepEqual(fetched, ['https://provider.invalid/one']);
    // The metered calls did reach the real bindings.
    assert.ok(await fixture.env.RAW.head('synthetic/key'));
  } finally { await fixture.close(); }
});

test('invocation limits cap the sum of task allotments', async () => {
  const seen: number[] = [];
  const greedy = (name: string) => ({ name, schedule: 'frequent' as const, allotment: { d1: INVOCATION_LIMITS.d1, r2: 0, fetch: 0 },
    async run(metered: Env) { let count = 0;
      try { while (true) { await metered.DB.prepare('SELECT 1').first(); count++; } } catch { seen.push(count); }
      return { count }; } });
  const fixture = await (await import('./env-fixture')).createEnvFixture();
  try {
    await runMaintenance({ ...fixture.env, MAINTENANCE_TASKS: 'a,b' } as Env, { tasks: [greedy('a'), greedy('b')] });
  } finally { await fixture.close(); }
  assert.deepEqual(seen, [INVOCATION_LIMITS.d1, 0]);
});

test('every registered task has a unique stable name, a schedule and a bounded allotment', () => {
  const names = maintenanceTasks.map(task => task.name);
  for (const task of maintenanceTasks) {
    assert.ok(['frequent', 'hourly'].includes(task.schedule));
    for (const kind of ['d1', 'r2', 'fetch'] as const) assert.ok(Number.isInteger(task.allotment[kind]) && task.allotment[kind] >= 0 && task.allotment[kind] <= INVOCATION_LIMITS[kind]);
  }
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_.-]{1,63}$/);
});

test('the bundled Worker runs its scheduled handler without touching ingest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-scheduled-'));
  const mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'storage'), workers: [{
    name: 'scheduled', modules: true as const, scriptPath: resolve('dist/worker.mjs'), compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'scheduled-index' }, r2Buckets: { RAW: 'scheduled-raw' } }] }));
  try {
    await applyMigrations(await mf.getD1Database('DB'));
    const worker = await mf.getWorker();
    for (const cron of ['*/15 * * * *', '17 * * * *']) {
      const result = await worker.scheduled({ cron, scheduledTime: new Date('2026-10-08T00:00:00Z') });
      assert.equal(result.outcome, 'ok');
    }
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('the shared env fixture indexes synthetic events and exposes an optional backup bucket', async () => {
  const { createEnvFixture, syntheticEvent } = await import('./env-fixture');
  const fixture = await createEnvFixture({ backup: true });
  try {
    const ack = await fixture.ingest([syntheticEvent('fixture-1'), syntheticEvent('fixture-2', { session: 'session-b' })], 'mini');
    assert.equal(ack.accepted, 2);
    assert.equal((await fixture.event('fixture-1'))!.device_id, 'mini');
    assert.ok(fixture.env.BACKUP);
  } finally { await fixture.close(); }
});
