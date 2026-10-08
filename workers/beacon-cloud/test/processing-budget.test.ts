import test from 'node:test';
import assert from 'node:assert/strict';
import { processingRead, processingWrite } from '../src/processing';
import { CallRequest, finishCall, parseBudget, reserveCall, sweepStaleReservations } from '../src/processing-budget';
import { Env, HttpError } from '../src/types';
import { createEnvFixture, syntheticEvent } from './env-fixture';
import { budget, count, post, reviewer, run, setBudget, setPolicy, workspace } from './processing-helpers';
const day = '2026-10-09', now = '2026-10-09T12:00:00.000Z';
const usage = async (env: Env, query = '?day=' + day) =>
  (await processingRead(new Request('http://localhost/api/processing/usage' + query), env))!.json() as Promise<any>;

/** Plan one job per synthetic repository and hold each under a live lease, as a running invocation would. */
async function runningJobs(f: Awaited<ReturnType<typeof createEnvFixture>>, total: number, owner = 'owner-a') {
  await setPolicy(f.env, workspace, { min_new_events: 1000 });
  const ids: string[] = [];
  for (let index = 0; index < total; index++) {
    await f.ingest(syntheticEvent(`budget-${index}-${crypto.randomUUID()}`, { repo: `budget-${ids.length}-${index}`, session: `s-${index}` }));
    const project = (await f.env.DB.prepare('SELECT project_id FROM events ORDER BY rowid DESC LIMIT 1').first<{ project_id: string }>())!.project_id;
    ids.push((await run(f.env, { project_id: project })).scopes[0].job_id);
  }
  await f.env.DB.prepare(`UPDATE processing_jobs SET status='running',attempts=1,lease_owner=?,lease_until=? WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(owner, '2026-10-09T12:30:00.000Z', JSON.stringify(ids)).run();
  return ids;
}
const call = (jobId: string, overrides: Partial<CallRequest> = {}): CallRequest => ({ job_id: jobId, provider: 'jev', model: 'jev-latest',
  attempt: 1, lease_owner: 'owner-a', input_chars: 3000, day, now, ...overrides });

test('budget writes are validated full replacements, versioned and audited; the ledger tables refuse rewrites', async () => {
  const f = await createEnvFixture();
  try {
    for (const invalid of [{}, { ...budget, daily_call_limit: 10_001 }, { ...budget, daily_call_limit: 1.5 }, { ...budget, daily_token_limit: -1 },
      { ...budget, daily_usd_ceiling: -0.01 }, { ...budget, daily_usd_ceiling: 10_001 }, { ...budget, daily_usd_ceiling: '1' },
      { ...budget, max_input_chars: 999 }, { ...budget, max_output_tokens: 0 }, { ...budget, timeout_ms: 30_001 }, { ...budget, timeout_ms: 999 },
      { ...budget, actor: 'forged' }, (({ timeout_ms, ...rest }) => rest)(budget), null, [], 'budget'])
      assert.throws(() => parseBudget(invalid), (error: unknown) => error instanceof HttpError && error.status === 400, JSON.stringify(invalid));
    const empty = await usage(f.env);
    assert.deepEqual([empty.budget.configured, empty.budget.daily_call_limit, empty.budget.external_enabled, empty.audit.length], [false, 0, false, 0]);
    const first = await setBudget(f.env, { daily_call_limit: 2, daily_usd_ceiling: 0.5 });
    assert.deepEqual([first.budget.version, first.budget.updated_by, first.budget.daily_usd_ceiling, first.budget.external_enabled], [1, reviewer, 0.5, true]);
    const second = await setBudget(f.env, { daily_call_limit: 0 });
    assert.deepEqual([second.budget.version, second.budget.daily_call_limit, second.budget.external_enabled], [2, 0, false]);
    assert.deepEqual(second.audit.map((row: any) => [row.version, row.actor]), [[2, reviewer], [1, reviewer]]);
    const stored = await f.env.DB.prepare('SELECT budget FROM processing_budget_audit WHERE version=1').first<{ budget: string }>();
    assert.deepEqual(JSON.parse(stored!.budget), { ...budget, daily_call_limit: 2, daily_usd_ceiling: 0.5 });
    await assert.rejects(f.env.DB.prepare('DELETE FROM processing_budget').run(), /processing_immutable/);
    await assert.rejects(f.env.DB.prepare('UPDATE processing_budget_audit SET actor=?').bind('forged').run(), /processing_immutable/);
    await assert.rejects(f.env.DB.prepare('DELETE FROM processing_budget_audit').run(), /processing_immutable/);
    const reject = (operation: Promise<unknown>, status: number) =>
      assert.rejects(operation, (error: unknown) => error instanceof HttpError && error.status === status);
    await reject(processingWrite(new Request('http://localhost/api/processing/budget', { method: 'POST', body: '{}' }), f.env, reviewer), 415);
    await reject(processingWrite(post('/api/processing/budget?x=1', budget), f.env, reviewer), 400);
    for (const query of ['?day=2026-02-30', '?day=26-10-09', '?day=', '?limit=1', '?day=' + day + '&day=' + day])
      await reject(processingRead(new Request('http://localhost/api/processing/usage' + query), f.env), 400);
  } finally { await f.close(); }
});

test('reservations check the lease, input size and the daily call, token and USD limits, and refuse duplicates', async () => {
  const f = await createEnvFixture();
  try {
    const [a, b, c, d] = await runningJobs(f, 4);
    // No budget row: everything is zero.
    assert.deepEqual(await reserveCall(f.env, call(a)), { reserved: false, code: 'budget_disabled' });
    await setBudget(f.env, { daily_call_limit: 0 });
    assert.deepEqual(await reserveCall(f.env, call(a)), { reserved: false, code: 'budget_disabled' });
    await setBudget(f.env, { daily_call_limit: 2, daily_token_limit: 2000, max_input_chars: 4000 });
    assert.deepEqual(await reserveCall(f.env, call(a, { lease_owner: 'someone-else' })), { reserved: false, code: 'lease_lost' });
    assert.deepEqual(await reserveCall(f.env, call(a, { attempt: 2 })), { reserved: false, code: 'lease_lost' });
    assert.deepEqual(await reserveCall(f.env, call(a, { input_chars: 4001 })), { reserved: false, code: 'input_too_large' });
    const first = await reserveCall(f.env, call(a));
    assert.ok(first.reserved);
    // ceil(3000/3) + max_output_tokens.
    assert.equal(first.call.estimated_tokens, 1256);
    assert.deepEqual(await reserveCall(f.env, call(a)), { reserved: false, code: 'duplicate' });
    // 1256 already counted + 1256 > 2000.
    assert.deepEqual(await reserveCall(f.env, call(b)), { reserved: false, code: 'daily_token_limit' });
    // Reported usage replaces the estimate once the provider answers.
    assert.equal(await finishCall(f.env, first.call.id, { status: 'succeeded', input_tokens: 300, output_tokens: 20, reported_cost_usd: 0.002,
      finished_at: now }), true);
    assert.equal(await finishCall(f.env, first.call.id, { status: 'failed', error_code: 'late', finished_at: now }), false);
    const second = await reserveCall(f.env, call(b));
    assert.ok(second.reserved);
    assert.deepEqual(await reserveCall(f.env, call(c, { input_chars: 30 })), { reserved: false, code: 'daily_call_limit' });
    // Another UTC day has its own limits.
    assert.ok((await reserveCall(f.env, call(c, { day: '2026-10-10' }))).reserved);
    // The USD ceiling binds only on reported cost: 0.002 reported against a 0.002 ceiling.
    await setBudget(f.env, { daily_call_limit: 10, daily_token_limit: 100_000, daily_usd_ceiling: 0.002 });
    assert.deepEqual(await reserveCall(f.env, call(d)), { reserved: false, code: 'usd_ceiling' });
    await setBudget(f.env, { daily_call_limit: 10, daily_token_limit: 100_000, daily_usd_ceiling: 0.0021 });
    assert.ok((await reserveCall(f.env, call(d))).reserved);
    const view = await usage(f.env);
    assert.deepEqual([view.usage.calls, view.usage.reserved, view.usage.succeeded, view.usage.counted_tokens, view.usage.reported_cost_usd],
      [3, 2, 1, 320 + 1256 + 1256, 0.002]);
    assert.deepEqual([view.remaining.calls, view.remaining.tokens], [7, 100_000 - 2832]);
    assert.equal(view.calls.length, 3);
    assert.ok(view.calls.every((row: any) => !('content' in row)));
    // Ledger rows keep their identity and only leave `reserved` once.
    await assert.rejects(f.env.DB.prepare('UPDATE processing_calls SET day=? WHERE id=?').bind('2026-10-11', first.call.id).run(), /processing_immutable/);
    await assert.rejects(f.env.DB.prepare('UPDATE processing_calls SET status=? WHERE id=?').bind('reserved', first.call.id).run(), /processing_call_transition/);
    await assert.rejects(f.env.DB.prepare('DELETE FROM processing_calls').run(), /processing_immutable/);
  } finally { await f.close(); }
});

test('a reservation race with a limit of one lets exactly one call through', async () => {
  const f = await createEnvFixture();
  try {
    const ids = await runningJobs(f, 8);
    await setBudget(f.env, { daily_call_limit: 1 });
    const results = await Promise.all(ids.map((id) => reserveCall(f.env, call(id))));
    assert.equal(results.filter((result) => result.reserved).length, 1);
    assert.deepEqual(results.filter((result) => !result.reserved).map((result) => (result as any).code), Array(7).fill('daily_call_limit'));
    assert.equal(await count(f.env, 'processing_calls'), 1);
    // The same job attempt racing itself also reserves once, whatever the limit.
    await setBudget(f.env, { daily_call_limit: 100 });
    const same = await Promise.all(Array.from({ length: 5 }, () => reserveCall(f.env, call(ids[1], { day: '2026-10-10' }))));
    assert.equal(same.filter((result) => result.reserved).length, 1);
    assert.equal(await count(f.env, 'processing_calls WHERE day=?', '2026-10-10'), 1);
  } finally { await f.close(); }
});

test('stale reservations become outcome_unknown and still count; live leases and recent calls are left alone', async () => {
  const f = await createEnvFixture();
  try {
    const [dead, live, reclaimed, recent] = await runningJobs(f, 4);
    await setBudget(f.env, { daily_call_limit: 4 });
    const old = '2026-10-09T11:00:00.000Z';
    const reservations = [];
    for (const [id, started] of [[dead, old], [live, old], [reclaimed, old], [recent, '2026-10-09T11:59:00.000Z']])
      reservations.push(await reserveCall(f.env, call(id, { now: started })));
    assert.ok(reservations.every((result) => result.reserved));
    // The first job's invocation died and its lease lapsed; the third was reclaimed by a later attempt.
    await f.env.DB.prepare(`UPDATE processing_jobs SET lease_until=? WHERE id=?`).bind('2026-10-09T11:10:00.000Z', dead).run();
    await f.env.DB.prepare(`UPDATE processing_jobs SET attempts=2,lease_owner='owner-b' WHERE id=?`).bind(reclaimed).run();
    assert.equal(await sweepStaleReservations(f.env, new Date(now)), 2);
    const rows = (await f.env.DB.prepare('SELECT job_id,status,error_code FROM processing_calls ORDER BY started_at,job_id').all<any>()).results;
    const status = Object.fromEntries(rows.map((row) => [row.job_id, [row.status, row.error_code]]));
    assert.deepEqual(status[dead], ['outcome_unknown', 'stale_reservation']);
    assert.deepEqual(status[reclaimed], ['outcome_unknown', 'stale_reservation']);
    assert.deepEqual(status[live], ['reserved', null]);
    assert.deepEqual(status[recent], ['reserved', null]);
    // An outcome_unknown call never turns into a success later, and it still uses up the day.
    const [unknown] = reservations as any[];
    assert.equal(await finishCall(f.env, unknown.call.id, { status: 'succeeded', finished_at: now }), false);
    const view = await usage(f.env);
    assert.deepEqual([view.usage.calls, view.usage.outcome_unknown, view.usage.reserved, view.remaining.calls], [4, 2, 2, 0]);
    assert.equal(view.usage.counted_tokens, 4 * 1256);
    assert.equal(view.usage.reported_cost_usd, null);
  } finally { await f.close(); }
});
