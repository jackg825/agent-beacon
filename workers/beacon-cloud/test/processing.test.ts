import test from 'node:test';
import assert from 'node:assert/strict';
import { insertCandidate } from '../src/context';
import { runMaintenance } from '../src/maintenance';
import { PROCESSING_ALLOTMENT, processingMaintenance, processingWrite } from '../src/processing';
import { MAX_ATTEMPTS, planTick } from '../src/processing-planner';
import { BACKOFF_MINUTES, EXTERNAL_TIMEOUT_MS, LEASE_MIN_MS } from '../src/processing-runner';
import { SelectionStage } from '../src/processing-stage';
import { projectWrite } from '../src/project-workflows';
import { Env } from '../src/types';
import { createEnvFixture, syntheticEvent } from './env-fixture';
import { at, command, count, job, jobs, later, link, newTask, post, rejects, review, reviewer, run, setPolicy, staged, tick,
  workspace } from './processing-helpers';

test('processing is inert by default: open tasks with linked sessions plan nothing and run refuses disabled scopes', async () => {
  const f = await createEnvFixture();
  try {
    await f.ingest([syntheticEvent('inert-1'), syntheticEvent('inert-2', { session: 'session-b' })]);
    await f.ingest(syntheticEvent('inert-3', { session: 'mini-session' }), 'mini');
    const project = (await f.event('inert-1'))!.project_id;
    const sessions = [(await f.event('inert-1'))!.session_id, (await f.event('inert-3'))!.session_id];
    const taskId = await newTask(f.env, 'Synthetic open task', sessions);
    // Nothing named in MAINTENANCE_TASKS: the task never runs and touches nothing.
    assert.deepEqual(await runMaintenance(f.env, { now: later(), tasks: processingMaintenance }), {});
    for (const minutes of [60, 120, 240]) {
      const report = await tick(f.env, later(minutes));
      assert.equal(report.ok, true);
      assert.equal(report.result!.workspace_enabled, false);
      assert.equal(report.result!.planned, 0);
      // Lease and stale-reservation sweeps, workspace policy lookup and one claim attempt; no scope or raw reads.
      assert.deepEqual(report.usage, { d1: 4, r2: 0, fetch: 0 });
    }
    // A project row cannot enable anything without the workspace ceiling.
    await setPolicy(f.env, { scope_type: 'project', scope_id: project });
    assert.equal((await tick(f.env)).result!.planned, 0);
    await rejects(processingWrite(post('/api/processing/run', { task_id: taskId }), f.env, reviewer), 409);
    await rejects(processingWrite(post('/api/processing/run', { project_id: project }), f.env, reviewer), 409);
    // Enabled workspace with the project switched off still refuses that project's scopes.
    await setPolicy(f.env, workspace);
    await setPolicy(f.env, { scope_type: 'project', scope_id: project }, { enabled: false });
    assert.equal((await tick(f.env)).result!.planned, 0);
    await rejects(processingWrite(post('/api/processing/run', { task_id: taskId }), f.env, reviewer), 409);
    assert.equal(await count(f.env, 'processing_jobs'), 0);
    assert.equal(await count(f.env, 'context_entries'), 0);
  } finally { await f.close(); }
});

test('timing rules: minimum new events, quiet minutes plus settle lag, and idempotent re-planning', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, { min_new_events: 3, quiet_minutes: 30 });
    await f.ingest([syntheticEvent('due-1', { timestamp: at(1) }), syntheticEvent('due-2', { timestamp: at(2) })]);
    assert.deepEqual((await planTick(f.env, later(60))).outcomes, { not_due: 1 });
    await f.ingest(syntheticEvent('due-3', { timestamp: at(3) }));
    const minutes = (value: number) => new Date(Date.now() + value * 60_000);
    assert.deepEqual((await planTick(f.env, minutes(1))).outcomes, { not_due: 1 });
    // quiet_minutes alone is not enough: the 2 minute settle lag applies on top.
    assert.deepEqual((await planTick(f.env, minutes(31))).outcomes, { not_due: 1 });
    const planned = await planTick(f.env, minutes(33));
    assert.deepEqual(planned.outcomes, { planned: 1 });
    assert.deepEqual((await planTick(f.env, minutes(34))).outcomes, { live_job: 1 });
    const project = (await f.event('due-1'))!.project_id;
    const again = await run(f.env, { project_id: project });
    assert.deepEqual(again.scopes.map((scope: any) => [scope.status, scope.job_id]), [['live_job', planned.planned[0]]]);
    const [only] = await jobs(f.env);
    assert.equal(only.source_count, 3);
    assert.equal(await count(f.env, 'processing_job_sources WHERE job_id=?', only.id), 3);
    // The database itself refuses a second live job for the same scope.
    await assert.rejects(f.env.DB.prepare(`INSERT INTO processing_jobs(id,kind,scope_type,scope_id,project_id,scope_key,source_set_hash,
      policy_hash,processor_version,status,next_attempt_at,source_count,planned_by,created_at,updated_at)
      SELECT ?,kind,scope_type,scope_id,project_id,scope_key,source_set_hash,policy_hash,processor_version,'queued',next_attempt_at,
      source_count,planned_by,created_at,updated_at FROM processing_jobs WHERE id=?`).bind('f'.repeat(64), only.id).run(), /UNIQUE/);
    // A reviewer run ignores only the timing rules.
    await f.ingest(syntheticEvent('due-other', { repo: 'beta', session: 'beta-session' }));
    const beta = (await f.event('due-other'))!.project_id;
    assert.equal((await run(f.env, { project_id: beta })).scopes[0].status, 'planned');
  } finally { await f.close(); }
});

test('coverage selection: 450 events become three jobs covering each event exactly once, oldest first', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace);
    const events = Array.from({ length: 450 }, (_, index) => syntheticEvent(`bulk-${index}`, { timestamp: at(450 - index) }));
    for (let offset = 0; offset < 450; offset += 100) await f.ingest(events.slice(offset, offset + 100));
    const sizes: number[] = [];
    for (let round = 0; round < 3; round++) {
      const report = await tick(f.env, later(60 + round));
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.deepEqual(report.result!.run_outcomes, { succeeded: 1 });
      for (const kind of ['d1', 'r2', 'fetch'] as const) assert.ok(report.usage[kind] <= PROCESSING_ALLOTMENT[kind]);
      const latest = (await jobs(f.env)).at(-1);
      sizes.push(latest.source_count);
      // An unreviewed pipeline candidate defers the next job for the scope.
      assert.equal((await tick(f.env, later(70 + round))).result!.plan_outcomes.pending_candidate, 1);
      await review(f.env, latest.result_context_id);
    }
    assert.deepEqual(sizes, [200, 200, 50]);
    assert.equal(await count(f.env, 'processing_coverage'), 450);
    assert.equal(await count(f.env, '(SELECT DISTINCT event_id FROM processing_coverage)'), 450);
    const first = (await jobs(f.env))[0];
    const oldest = await f.env.DB.prepare(`SELECT MAX(e.timestamp) AS newest FROM processing_job_sources s JOIN events e ON e.id=s.event_id
      WHERE s.job_id=?`).bind(first.id).first<{ newest: string }>();
    assert.equal(oldest!.newest, new Date(at(200)).toISOString());
    const report = await tick(f.env, later(90));
    assert.deepEqual(report.result!.plan_outcomes, { empty: 1 });
    assert.equal((await jobs(f.env)).length, 3);
  } finally { await f.close(); }
});

test('late events: an old-timestamp backfill and a session linked to the task later are both covered next', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace);
    await f.ingest([command('late-a1', 'npm test', 1, { session: 'mbp-fix', timestamp: at(30) }),
      command('late-a2', 'npm test', 0, { session: 'mbp-fix', timestamp: at(31) })]);
    const sessionA = (await f.event('late-a1'))!.session_id;
    const taskId = await newTask(f.env, 'Synthetic late-link task', [sessionA]);
    await tick(f.env, later(60));
    const [first] = await jobs(f.env);
    assert.equal(first.scope_type, 'task'); assert.equal(first.status, 'succeeded'); assert.equal(first.source_count, 2);
    await review(f.env, first.result_context_id);
    // A backfill after sleep/offline carries an older timestamp than everything covered.
    await f.ingest(command('late-a0', 'git status', 0, { session: 'mbp-fix', timestamp: at(1) }));
    await tick(f.env, later(61));
    const second = (await jobs(f.env)).at(-1);
    assert.equal(second.source_count, 1);
    assert.equal((await f.env.DB.prepare('SELECT event_id FROM processing_job_sources WHERE job_id=?').bind(second.id).first<any>()).event_id,
      (await f.event('late-a0'))!.id);
    await review(f.env, second.result_context_id);
    // The Mac mini test session ran earlier; it starts in the project scope and joins the task later.
    await f.ingest(command('late-b1', 'npm test', 0, { session: 'mini-test', timestamp: at(20) }), 'mini');
    await tick(f.env, later(62));
    const projectJob = (await jobs(f.env)).at(-1);
    assert.equal(projectJob.scope_type, 'project'); assert.equal(projectJob.status, 'succeeded');
    await review(f.env, projectJob.result_context_id);
    await link(f.env, taskId, (await f.event('late-b1'))!.session_id);
    await tick(f.env, later(63));
    const linked = (await jobs(f.env)).at(-1);
    assert.equal(linked.scope_type, 'task'); assert.equal(linked.source_count, 1); assert.equal(linked.status, 'succeeded');
    const taskKey = first.scope_key;
    assert.equal(linked.scope_key, taskKey);
    assert.equal(await count(f.env, 'processing_coverage WHERE scope_key=?', taskKey), 4);
  } finally { await f.close(); }
});

test('claim, backoff, max attempts, failed jobs blocking their scope, reviewer retry and dismiss', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace);
    const ack = await f.ingest(syntheticEvent('retry-1'));
    const key = (await f.env.DB.prepare('SELECT r2_key FROM batches WHERE id=?').bind(ack.batch_id).first<{ r2_key: string }>())!.r2_key;
    const raw = await (await f.env.RAW.get(key))!.text();
    await f.env.RAW.delete(key);
    const base = later(60), at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
    let report = await tick(f.env, base);
    assert.deepEqual(report.result!.run_outcomes, { retry: 1 });
    let [current] = await jobs(f.env);
    assert.equal(current.status, 'queued'); assert.equal(current.attempts, 1); assert.equal(current.last_error, 'raw_unavailable');
    assert.equal(current.next_attempt_at, at(1).toISOString());
    assert.equal((await tick(f.env, at(0.5))).result!.claimed, 0);
    let elapsed = 1;
    for (const [attempt, backoff] of [[2, 5], [3, 30]] as const) {
      await tick(f.env, at(elapsed));
      current = await job(f.env, current.id);
      assert.equal(current.attempts, attempt); assert.equal(current.status, 'queued');
      assert.equal(current.next_attempt_at, at(elapsed + backoff).toISOString());
      elapsed += backoff;
    }
    // The fourth failure ends the job: three retries (1, 5 and 30 minutes) and no fourth backoff.
    assert.deepEqual([BACKOFF_MINUTES, MAX_ATTEMPTS], [[1, 5, 30], 4]);
    report = await tick(f.env, at(elapsed + 3));
    assert.deepEqual(report.result!.run_outcomes, { failed: 1 });
    current = await job(f.env, current.id);
    assert.equal(current.status, 'failed'); assert.equal(current.attempts, 4); assert.equal(current.last_error, 'raw_unavailable');
    // Nothing will retry it, so it keeps the time it was last due rather than showing a future attempt.
    assert.equal(current.next_attempt_at, at(elapsed).toISOString());
    // A failed job keeps its scope blocked until a reviewer acts.
    assert.deepEqual((await tick(f.env, at(elapsed + 200))).result!.plan_outcomes, { live_job: 1 });
    const change = (id: string, action: string, body: unknown = {}) => processingWrite(post(`/api/processing/jobs/${id}/${action}`, body), f.env, reviewer);
    await rejects(change(current.id, 'retry', { reason: 'x'.repeat(2001) }), 400);
    await rejects(change(current.id, 'retry', { unexpected: true }), 400);
    await rejects(change('0'.repeat(64), 'retry'), 404);
    await rejects(change('not-a-job', 'retry'), 400);
    const retried = await (await change(current.id, 'retry', { reason: 'Synthetic raw restored' }))!.json() as any;
    assert.equal(retried.job.status, 'queued'); assert.equal(retried.job.attempts, 0);
    assert.deepEqual(retried.job.audit.map((row: any) => [row.action, row.actor, row.reason]), [['retry', reviewer, 'Synthetic raw restored']]);
    await f.env.RAW.put(key, raw);
    await tick(f.env, at(elapsed + 201));
    current = await job(f.env, current.id);
    assert.equal(current.status, 'succeeded'); assert.equal(current.attempts, 1); assert.equal(current.last_error, null);
    await rejects(change(current.id, 'retry'), 409);
    await rejects(change(current.id, 'dismiss'), 409);
    // Dismissing a failed job releases the scope without covering its events.
    await f.ingest(syntheticEvent('dismiss-1', { repo: 'beta', session: 'beta-session' }));
    const beta = await f.event('dismiss-1');
    const betaKey = (await f.env.DB.prepare('SELECT r2_key FROM batches WHERE id=?').bind(beta!.batch_id).first<{ r2_key: string }>())!.r2_key;
    await f.env.RAW.delete(betaKey);
    const planned = (await run(f.env, { project_id: beta!.project_id })).scopes[0];
    await f.env.DB.prepare(`UPDATE processing_jobs SET status='running',attempts=4,lease_owner='synthetic',lease_until=? WHERE id=?`)
      .bind(at(elapsed + 202).toISOString(), planned.job_id).run();
    assert.equal((await tick(f.env, at(elapsed + 300))).result!.expired, 1);
    assert.equal((await job(f.env, planned.job_id)).last_error, 'lease_expired');
    const dismissed = await (await change(planned.job_id, 'dismiss'))!.json() as any;
    assert.equal(dismissed.job.status, 'dismissed'); assert.equal(dismissed.job.covered_count, 0);
    // Identical inputs are not processed again; new evidence plans a new job that still includes the old event.
    assert.equal((await run(f.env, { project_id: beta!.project_id })).scopes[0].status, 'exists');
    await f.ingest(syntheticEvent('dismiss-2', { repo: 'beta', session: 'beta-session' }));
    const next = (await run(f.env, { project_id: beta!.project_id })).scopes[0];
    assert.equal(next.status, 'planned'); assert.equal(next.source_count, 2);
    await assert.rejects(f.env.DB.prepare('UPDATE processing_jobs SET status=? WHERE id=?').bind('queued', planned.job_id).run(), /processing_job_transition/);
    await assert.rejects(f.env.DB.prepare('UPDATE processing_jobs SET status=? WHERE id=?').bind('queued', current.id).run(), /processing_job_transition/);
    await assert.rejects(f.env.DB.prepare('DELETE FROM processing_jobs WHERE id=?').bind(current.id).run(), /processing_immutable/);
    await assert.rejects(f.env.DB.prepare('UPDATE processing_jobs SET source_set_hash=? WHERE id=?').bind('a'.repeat(64), current.id).run(), /processing_immutable/);
  } finally { await f.close(); }
});

test('expired leases are reclaimed, and a completion from a lost lease commits nothing', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace);
    await f.ingest(syntheticEvent('lease-1'));
    const [planned] = (await planTick(f.env, later(60))).planned;
    // A crashed invocation left the job running with an expired lease.
    await f.env.DB.prepare(`UPDATE processing_jobs SET status='running',attempts=1,lease_owner='crashed',lease_until=? WHERE id=?`)
      .bind(later(30).toISOString(), planned).run();
    assert.deepEqual((await tick(f.env, later(61))).result!.run_outcomes, { succeeded: 1 });
    assert.equal((await job(f.env, planned)).attempts, 2);
    await review(f.env, (await job(f.env, planned)).result_context_id);
    // Another invocation reclaims the job while this one is still working on it.
    const thief: SelectionStage = async ({ env, job_id }) => {
      await env.DB.prepare(`UPDATE processing_jobs SET lease_owner='other-invocation',attempts=attempts+1 WHERE id=?`).bind(job_id).run();
      return { decision: 'continue', signals: [] };
    };
    await f.ingest(syntheticEvent('lease-2'));
    const report = await runMaintenance({ ...f.env, MAINTENANCE_TASKS: 'processing' } as Env, { now: later(62), tasks: staged(thief) });
    assert.deepEqual(report.processing.result!.run_outcomes, { lease_lost: 1 });
    const stolen = (await jobs(f.env)).at(-1);
    assert.equal(stolen.status, 'running'); assert.equal(stolen.lease_owner, 'other-invocation');
    assert.equal(await count(f.env, 'context_generation WHERE job_id=?', stolen.id), 0);
    assert.equal(await count(f.env, 'processing_coverage WHERE job_id=?', stolen.id), 0);
    assert.equal(await count(f.env, 'context_entries'), 1);
    // The same fence guards skips, and the fence table never keeps a row.
    const skipThief: SelectionStage = async (input) => { await thief(input); return { decision: 'skip', skip_reason: 'synthetic', signals: [] }; };
    await f.env.DB.prepare(`UPDATE processing_jobs SET lease_until=? WHERE id=?`).bind(later(30).toISOString(), stolen.id).run();
    const skipped = await runMaintenance({ ...f.env, MAINTENANCE_TASKS: 'processing' } as Env, { now: later(63), tasks: staged(skipThief) });
    assert.deepEqual(skipped.processing.result!.run_outcomes, { lease_lost: 1 });
    assert.equal(await count(f.env, 'processing_coverage WHERE job_id=?', stolen.id), 0);
    assert.equal(await count(f.env, 'processing_job_fence'), 0);
    await assert.rejects(f.env.DB.prepare('INSERT INTO processing_job_fence(job_id,lease_owner,attempts) VALUES(?,?,?)')
      .bind(stolen.id, 'crashed', 1).run(), /processing_lease_lost/);
  } finally { await f.close(); }
});

test('a claim holds its lease for the invocation plus the longest call and a minute, and an overlapping tick leaves it alone', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, { min_new_events: 1000 });
    const base = later(60), held: { lease_until: string; overlap: any }[] = [];
    // While the job runs, another invocation starts five minutes later and must find nothing to claim.
    const stage: SelectionStage = async ({ env, job_id }) => {
      const row = await env.DB.prepare('SELECT lease_until FROM processing_jobs WHERE id=?').bind(job_id).first<{ lease_until: string }>();
      held.push({ lease_until: row!.lease_until, overlap: await tick(f.env, new Date(base.getTime() + 5 * 60_000)) });
      return { decision: 'continue', signals: [] };
    };
    for (const [index, budgetMs] of [25_000, 600_000].entries()) {
      await f.ingest(command(`hold-${index}`, 'npm test', 0, { repo: `hold-${index}`, session: `hold-${index}` }));
      await run(f.env, { project_id: (await f.event(`hold-${index}`))!.project_id });
      // A fixed clock: remaining() is exactly the invocation budget when the job is claimed.
      const report = await runMaintenance({ ...f.env, MAINTENANCE_TASKS: 'processing' } as Env,
        { now: base, tasks: staged(stage), budgetMs, clock: () => 0 });
      assert.deepEqual(report.processing.result!.run_outcomes, { succeeded: 1 });
    }
    // At least ten minutes; otherwise remaining time + the 30 s longest call + 60 s.
    assert.deepEqual(held.map((item) => Date.parse(item.lease_until) - base.getTime()), [LEASE_MIN_MS, 600_000 + EXTERNAL_TIMEOUT_MS + 60_000]);
    assert.deepEqual([LEASE_MIN_MS, EXTERNAL_TIMEOUT_MS], [10 * 60_000, 30_000]);
    for (const { overlap } of held) assert.deepEqual([overlap.ok, overlap.result.expired, overlap.result.claimed], [true, 0, 0]);
  } finally { await f.close(); }
});

test('crash after the candidate commit: the next claim records the existing candidate, never a second one', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace);
    await f.ingest([syntheticEvent('crash-1'), syntheticEvent('crash-2')]);
    const [planned] = (await planTick(f.env, later(60))).planned;
    const row = await job(f.env, planned);
    await f.env.DB.prepare(`UPDATE processing_jobs SET status='running',attempts=1,lease_owner='crashed',lease_until=? WHERE id=?`)
      .bind(later(30).toISOString(), planned).run();
    const first = await f.event('crash-1');
    // The candidate and its generation row committed, but the job's own completion was lost.
    const committed = await insertCandidate(f.env, { kind: 'summary', project_id: row.project_id, title: 'Synthetic committed candidate',
      content: 'Synthetic content committed before a crash.', sources: [{ event_id: first!.id, payload_hash: first!.payload_hash }] },
      'pipeline:beacon.extractive@1', { after: (contextId, createdAt) => [f.env.DB.prepare(`INSERT INTO context_generation(context_id,job_id,
        processor,scope_key,previous_context_id,created_at) VALUES(?,?,?,?,NULL,?)`).bind(contextId, planned, 'beacon.extractive.v1', row.scope_key, createdAt)] });
    const report = await tick(f.env, later(61));
    assert.deepEqual(report.result!.run_outcomes, { recovered: 1 });
    const done = await job(f.env, planned);
    assert.equal(done.status, 'succeeded'); assert.equal(done.result_context_id, committed);
    assert.equal(await count(f.env, 'context_entries'), 1);
    assert.equal(await count(f.env, 'processing_coverage WHERE job_id=?', planned), 2);
    await assert.rejects(f.env.DB.prepare(`INSERT INTO context_generation(context_id,job_id,processor,scope_key,created_at)
      SELECT id,?,'beacon.extractive.v1',?,created_at FROM context_entries WHERE id=?`).bind(planned, row.scope_key, committed).run(), /UNIQUE/);
  } finally { await f.close(); }
});

test('run-time re-validation: a changed policy or scope ends the job as skipped before any raw read or call', async () => {
  const f = await createEnvFixture({ bindings: { EXTERNAL_PROCESSING_PROJECTS: '*', JEV_API_KEY: 'synthetic-jev-key-not-real-0000' } });
  try {
    const external = { external_allowed: true, jev_enabled: true, summary_fields: ['command_text', 'titles'], external_fields: ['command_text'] };
    await setPolicy(f.env, workspace, external);
    await f.ingest([command('policy-1', 'npm test', 0), command('policy-2', 'npm run lint', 0)]);
    const [planned] = (await planTick(f.env, later(60))).planned;
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('{}'); }) as typeof fetch;
    // Revoke external use between planning and running.
    await setPolicy(f.env, workspace, { ...external, external_allowed: false });
    const rawReads = (await tick(f.env, later(61), { fetcher }));
    assert.deepEqual(rawReads.result!.run_outcomes, { skipped: 1 });
    assert.equal(rawReads.usage.r2, 0);
    assert.equal(rawReads.usage.fetch, 0);
    let current = await job(f.env, planned);
    assert.equal(current.status, 'skipped'); assert.equal(current.skip_reason, 'policy_changed');
    assert.equal(await count(f.env, 'processing_coverage'), 0);
    // Restoring the same policy re-plans the same identity, which then runs.
    await setPolicy(f.env, workspace, external);
    const report = await tick(f.env, later(62), { fetcher });
    assert.deepEqual(report.result!.plan_outcomes, { requeued: 1 });
    current = await job(f.env, planned);
    assert.equal(current.status, 'succeeded'); assert.equal(current.attempts, 1);
    assert.equal((await jobs(f.env)).length, 1);
    assert.deepEqual(calls, []);
    assert.equal(await count(f.env, 'context_entries'), 1);
  } finally { await f.close(); }
});

test('run-time re-validation: events that left the project, a completed task or a newly linked session skip the job', async () => {
  const f = await createEnvFixture();
  try {
    // Automatic planning never becomes due here; reviewer runs plan each scope explicitly.
    await setPolicy(f.env, workspace, { min_new_events: 1000 });
    await f.ingest(syntheticEvent('scope-other', { repo: 'beta', session: 'beta-session' }));
    const beta = (await f.event('scope-other'))!.project_id;
    await f.ingest(command('scope-1', 'npm test', 0));
    const moving = (await f.event('scope-1'))!;
    const moved = (await run(f.env, { project_id: moving.project_id })).scopes[0];
    assert.equal(moved.status, 'planned');
    // Ingest can re-attribute an event when its session gains a stronger project identity.
    await f.env.DB.prepare('UPDATE events SET project_id=? WHERE id=?').bind(beta, moving.id).run();
    const report = await tick(f.env, later(60));
    assert.deepEqual(report.result!.run_outcomes, { skipped: 1 });
    assert.equal(report.usage.r2, 0);
    assert.equal((await job(f.env, moved.job_id)).skip_reason, 'scope_changed');
    await f.env.DB.prepare('UPDATE events SET project_id=? WHERE id=?').bind(moving.project_id, moving.id).run();

    await f.ingest(command('task-1', 'npm test', 0, { session: 'task-session' }));
    const taskId = await newTask(f.env, 'Synthetic soon completed', [(await f.event('task-1'))!.session_id]);
    const taskPlan = (await run(f.env, { task_id: taskId })).scopes[0];
    assert.equal(taskPlan.status, 'planned');
    await projectWrite(post(`/api/tasks/${taskId}/status`, { status: 'completed' }), f.env, reviewer);
    await rejects(processingWrite(post('/api/processing/run', { task_id: taskId }), f.env, reviewer), 409);
    await tick(f.env, later(61));
    assert.equal((await job(f.env, taskPlan.job_id)).skip_reason, 'scope_changed');

    await f.ingest(command('project-only', 'npm test', 0, { session: 'loose-session' }));
    const projectPlan = (await run(f.env, { project_id: moving.project_id })).scopes[0];
    assert.equal(projectPlan.status, 'planned');
    assert.equal(projectPlan.source_count, 3);
    await newTask(f.env, 'Synthetic late link', [(await f.event('project-only'))!.session_id]);
    await tick(f.env, later(62));
    assert.equal((await job(f.env, projectPlan.job_id)).skip_reason, 'scope_changed');
    assert.equal(await count(f.env, 'processing_coverage'), 0);
    assert.equal(await count(f.env, 'context_entries'), 0);
  } finally { await f.close(); }
});
