import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyInput, applyRetention, blockedWithin, parseApply, planHash, retentionPlan, retentionRead, retentionWrite } from '../src/retention';
import { dataHealth } from '../src/health';
import { runMaintenance } from '../src/maintenance';
import { MaintenanceError } from '../src/maintenance-error';
import { processingWrite } from '../src/processing';
import { planRequest } from '../src/processing-planner';
import { SelectionStage, ruleFilter } from '../src/processing-stage';
import { Env, HttpError } from '../src/types';
import { httpSource, restoreCheck, verifyRequest } from '../scripts/restore-check';
import { createEnvFixture, migrationsExcept, syntheticEvent } from './env-fixture';
import { revisionsWrite } from '../src/context-revisions';
import { backupTick, completeCheckpoint, createContext, drill, get, later, latestCheckpoint, operationsTokens,
  operationsWorker, post, reviewer, verifiedCheckpoint } from './operations-fixture';
import { job, setPolicy as setProcessingPolicy, staged, workspace } from './processing-helpers';

const DAY = 86400_000;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;
async function body(response: Response | null) { assert.ok(response); return response.json() as Promise<any>; }
const setPolicy = (env: Env, data_class: string, keep_days: number | null) => retentionWrite(post('/api/retention/policies', { data_class, keep_days }), env, reviewer);
const applyBody = (plan: any): ApplyInput => ({ data_class: 'raw', generated_at: plan.generated_at, cutoff: plan.cutoff, batch_ids: plan.batch_ids, plan_sha256: plan.plan_sha256 });
async function batchOf(env: Env, eventId: string) {
  return (await env.DB.prepare('SELECT b.id,b.r2_key,b.received_at FROM events e JOIN batches b ON b.id=e.batch_id WHERE e.event_id=?').bind(eventId).first<any>())!;
}
async function count(env: Env, sql: string, ...values: unknown[]) {
  return (await env.DB.prepare(sql).bind(...values).first<{ n: number }>())!.n;
}

test('retention policies are reviewer records; only raw is enforceable', async () => {
  const fixture = await createEnvFixture();
  try {
    const env = fixture.env;
    const initial = await body(await retentionRead(get('/api/retention/policies'), env));
    assert.deepEqual(initial.policies.map((policy: any) => [policy.data_class, policy.keep_days, policy.enforced]),
      [['raw', null, true], ['summary', null, false], ['candidate', null, false], ['audit', null, false]]);
    for (const invalid of [{ data_class: 'raw', keep_days: 0 }, { data_class: 'raw', keep_days: 36501 }, { data_class: 'raw', keep_days: '7' },
      { data_class: 'events', keep_days: 7 }, { data_class: 'raw' }, { data_class: 'raw', keep_days: 7, actor: 'forged' }])
      await assert.rejects(retentionWrite(post('/api/retention/policies', invalid), env, reviewer), status(400), JSON.stringify(invalid));
    await setPolicy(env, 'summary', 30);
    const updated = await body(await setPolicy(env, 'raw', 90));
    assert.deepEqual(updated.policies.slice(0, 2).map((policy: any) => [policy.keep_days, policy.updated_by]), [[90, reviewer], [30, reviewer]]);
    await setPolicy(env, 'raw', null);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM retention_policy_audit'), 3);
    await assert.rejects(env.DB.prepare('UPDATE retention_policy_audit SET keep_days=1').run(), /retention_immutable/);
    await assert.rejects(env.DB.prepare('DELETE FROM retention_policy_audit').run(), /retention_immutable/);
    const plan = await retentionPlan(env, { now: later(3 * 24 * 60) });
    assert.equal(plan.plan, null);
    assert.deepEqual(plan.classes[0].blocked, [{ reason: 'within_keep_days', count: null }]);
    assert.deepEqual(plan.classes.slice(1).map((item: any) => [item.data_class, item.enforced, item.blocked[0].reason]),
      [['summary', false, 'class_report_only'], ['candidate', false, 'class_report_only'], ['audit', false, 'class_report_only']]);
    for (const query of ['/api/retention/plan?max_batches=0', '/api/retention/plan?max_batches=51', '/api/retention/plan?other=1', '/api/retention/policies?x=1'])
      await assert.rejects(retentionRead(get(query), env), status(400), query);
  } finally { await fixture.close(); }
});

test('raw retention deletes whole closed batch sets only behind a verified, integrity-checked backup', async (t) => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env;
    await fixture.ingest([syntheticEvent('keep-a1'), syntheticEvent('keep-a2')]);
    await fixture.ingest([syntheticEvent('keep-a1', { extra: { message: 'synthetic alternate capture' } }), syntheticEvent('keep-b1')]);
    await fixture.ingest([syntheticEvent('keep-c1')]);
    await fixture.ingest([syntheticEvent('keep-d1', { session: 'other' })]);
    const [a, b, c, d] = [await batchOf(env, 'keep-a1'), await batchOf(env, 'keep-b1'), await batchOf(env, 'keep-c1'), await batchOf(env, 'keep-d1')];
    const cited = (await fixture.event('keep-c1'))!;
    await createContext(env, { kind: 'memory', project_id: cited.project_id, title: 'Synthetic cited', content: 'Synthetic only.',
      sources: [{ event_id: cited.id, payload_hash: cited.payload_hash }] }, 'approve');
    await setPolicy(env, 'raw', 1);
    const now = later(2 * 24 * 60);
    await t.test('without a verified backup every batch is blocked', async () => {
      const plan = await retentionPlan(env, { now });
      assert.equal(plan.plan, null);
      assert.equal((plan.classes[0] as any).scanned, 4);
      assert.ok(plan.classes[0].blocked.some((item: any) => item.reason === 'no_verified_backup' && item.count === 4));
      await backupTick(env, later(15));
      const unverified = await retentionPlan(env, { now });
      assert.equal(unverified.plan, null, 'completed but not attested');
    });
    await verifiedCheckpoint(env, later(15));
    const checkpoint = (await latestCheckpoint(env))!;
    await t.test('closure, context references and keep days decide eligibility', async () => {
      // B's received time moves inside the keep window, so A (whose event has a version in B) cannot go alone.
      await env.DB.prepare('UPDATE batches SET received_at=? WHERE id=?').bind(new Date(now.getTime() - 3600_000).toISOString(), b.id).run();
      const plan = await retentionPlan(env, { now });
      const raw = plan.classes[0] as any;
      assert.deepEqual(plan.backup_checkpoint, { id: checkpoint.id, final_snapshot_at: checkpoint.final_snapshot_at });
      assert.deepEqual(plan.plan!.batch_ids, [d.id]);
      assert.equal(plan.plan!.plan_sha256, await planHash(plan.plan!.generated_at, plan.plan!.cutoff, [d.id]));
      assert.equal(plan.plan!.events, 1);
      assert.ok(plan.plan!.bytes > 0);
      assert.deepEqual(Object.fromEntries(raw.blocked.map((item: any) => [item.reason, item.count])),
        { referenced_by_context: 1, shared_event_versions: 1, within_keep_days: 1 });
      assert.deepEqual(raw.blocked_batches.map((item: any) => [item.batch_id, item.reasons]).sort(),
        [[a.id, ['shared_event_versions']], [c.id, ['referenced_by_context']]].sort());
      assert.ok(!JSON.stringify(plan).includes('synthetic alternate'));
      await env.DB.prepare('UPDATE batches SET received_at=? WHERE id=?').bind(b.received_at, b.id).run();
      // With B old enough, A and B leave together; a one-batch plan takes only B, which has no outside versions.
      assert.deepEqual(new Set((await retentionPlan(env, { now })).plan!.batch_ids), new Set([a.id, b.id, d.id]));
      assert.deepEqual((await retentionPlan(env, { now, maxBatches: 1 })).plan!.batch_ids, [b.id]);
      assert.deepEqual([...blockedWithin(new Set([a.id]), new Map([[a.id, new Set()]]), [{ home: a.id, other: b.id }])], [a.id]);
    });
    await t.test('stale, tampered or changed plans are refused', async () => {
      const plan = (await retentionPlan(env, { now })).plan!;
      const input = applyBody(plan);
      await assert.rejects(applyRetention(env, { ...input, plan_sha256: 'f'.repeat(64) }, reviewer, now), status(409));
      await assert.rejects(applyRetention(env, { ...input, batch_ids: [...input.batch_ids].reverse() }, reviewer, now), status(409));
      await assert.rejects(applyRetention(env, input, reviewer, new Date(now.getTime() + 61 * 60_000)), status(409));
      await assert.rejects(applyRetention(env, { ...input, batch_ids: [d.id, d.id] }, reviewer, now), status(400));
      await setPolicy(env, 'raw', 5);
      await assert.rejects(applyRetention(env, input, reviewer, now), (error: any) => error.status === 409 && /policy changed/.test(error.message));
      await setPolicy(env, 'raw', 1);
      await assert.rejects(applyRetention({ ...env, BACKUP: undefined } as Env, input, reviewer, now), (error: any) => /Backup bucket/.test(error.message));
      // A new reference after planning blocks the batch at apply time.
      const fresh = (await fixture.event('keep-d1'))!;
      const later_note = await createContext(env, { kind: 'summary', project_id: fresh.project_id, title: 'Synthetic late citation', content: 'Synthetic only.',
        sources: [{ event_id: fresh.id, payload_hash: fresh.payload_hash }] });
      const refused = await applyRetention(env, input, reviewer, now);
      assert.equal(refused.status, 409);
      assert.deepEqual((await refused.json() as any).blocked.find((item: any) => item.batch_id === d.id).reasons, ['referenced_by_context']);
      assert.ok(later_note);
      // A running checkpoint blocks apply so its raw list stays exact.
      await env.DB.prepare(`INSERT INTO backup_checkpoints(id,status,phase,started_at,started_by,updated_at) VALUES(?,'running','chunks',?,?,?)`)
        .bind(crypto.randomUUID(), now.toISOString(), reviewer, now.toISOString()).run();
      const withoutD = (await retentionPlan(env, { now })).plan!;
      assert.equal((await retentionPlan(env, { now })).backup_running, true);
      await assert.rejects(applyRetention(env, applyBody(withoutD), reviewer, now), (error: any) => error.status === 409 && /running/.test(error.message));
      await env.DB.prepare("UPDATE backup_checkpoints SET status='failed' WHERE status='running'").run();
      // A BACKUP copy that changed since the copy was recorded refuses the whole plan: a different
      // size, the same size with different bytes and no stored checksum (a plain overwrite), and the
      // same size with different bytes that carry their own checksum.
      const original = new Uint8Array(await (await env.RAW.get(a.r2_key))!.arrayBuffer());
      const sameSize = original.map((byte, index) => index === 0 ? byte ^ 0x20 : byte);
      for (const [body, options] of [['synthetic replaced copy', {}], [sameSize, {}], [sameSize, { sha256: sha(sameSize) }]] as const) {
        await env.BACKUP!.put('raw/' + a.r2_key, body, options);
        const changed = await applyRetention(env, applyBody(withoutD), reviewer, now);
        assert.equal(changed.status, 409);
        assert.equal((await changed.json() as any).batch_id, a.id);
        assert.ok(await env.RAW.head(a.r2_key), 'the primary copy stays');
      }
      await env.BACKUP!.put('raw/' + a.r2_key, original,
        { sha256: (await env.DB.prepare('SELECT sha256 FROM backup_raw_objects WHERE batch_id=?').bind(a.id).first<any>()).sha256 });
      assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM batches'), 4);
      assert.throws(() => parseApply({ ...input, extra: 1 }), status(400));
      assert.throws(() => parseApply({ ...input, batch_ids: Array(51).fill(d.id) }), status(400));
    });
    await t.test('apply deletes versions, events and batches, then RAW objects, and records every key', async () => {
      const plan = (await retentionPlan(env, { now })).plan!;
      assert.deepEqual(new Set(plan.batch_ids), new Set([a.id, b.id]));
      const versions = await count(env, `SELECT COUNT(*) AS n FROM event_versions WHERE batch_id IN (?,?)`, a.id, b.id);
      const response = await applyRetention(env, applyBody(plan), reviewer, now);
      assert.equal(response.status, 201);
      const result = await response.json() as any;
      assert.equal(result.raw_deleted, true);
      assert.deepEqual([result.run.batch_count, result.run.event_count, result.run.version_count, result.run.checkpoint_id], [2, 3, versions, checkpoint.id]);
      assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM batches WHERE id IN (?,?)', a.id, b.id), 0);
      assert.equal(await count(env, "SELECT COUNT(*) AS n FROM events WHERE event_id IN ('keep-a1','keep-a2','keep-b1')"), 0);
      assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM event_versions WHERE batch_id IN (?,?)', a.id, b.id), 0);
      assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM sessions'), 2, 'sessions are kept');
      assert.equal(await env.RAW.head(a.r2_key), null);
      assert.ok(await env.BACKUP!.head('raw/' + a.r2_key), 'the BACKUP copy waits out the grace period');
      const objects = await env.DB.prepare('SELECT batch_id,raw_deleted_at,backup_delete_after FROM retention_run_objects WHERE run_id=?').bind(result.run.id).all<any>();
      assert.equal(objects.results.length, 2);
      assert.ok(objects.results.every((row: any) => row.raw_deleted_at && Date.parse(row.backup_delete_after) - now.getTime() === 30 * DAY));
      await assert.rejects(applyRetention(env, applyBody(plan), reviewer, now), status(409));
      await assert.rejects(env.DB.prepare('UPDATE retention_runs SET actor=?').bind('forged').run(), /retention_immutable/);
      await assert.rejects(env.DB.prepare('DELETE FROM retention_run_objects').run(), /retention_immutable/);
      await assert.rejects(env.DB.prepare('UPDATE retention_run_objects SET raw_deleted_at=?').bind('2000-01-01T00:00:00.000Z').run(), /retention_immutable/);
      await assert.rejects(env.DB.prepare('UPDATE retention_run_objects SET backup_delete_after=?').bind(now.toISOString()).run(), /retention_immutable/);
    });
  } finally { await fixture.close(); }
});

test('failed RAW deletes are retried, BACKUP copies leave after grace and resurrected batches are reported', async () => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env;
    const record = syntheticEvent('grace-1');
    await fixture.ingest([record]);
    await fixture.ingest([syntheticEvent('grace-2', { session: 'grace-other' })]);
    await verifiedCheckpoint(env, later(15));
    await setPolicy(env, 'raw', 1);
    const now = later(2 * 24 * 60);
    const plan = (await retentionPlan(env, { now })).plan!;
    assert.equal(plan.batch_ids.length, 2);
    const failing = { ...env, RAW: new Proxy(env.RAW, { get(target, property) {
      if (property === 'delete') return async () => { throw new Error('synthetic R2 outage'); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    const response = await applyRetention(failing, applyBody(plan), reviewer, now);
    assert.equal(response.status, 201);
    const run = await response.json() as any;
    assert.equal(run.raw_deleted, false);
    const keys = (await env.DB.prepare('SELECT r2_key FROM retention_run_objects').all<{ r2_key: string }>()).results.map(row => row.r2_key);
    for (const key of keys) assert.ok(await env.RAW.head(key), 'RAW object still present after the failed delete');
    const pending = await dataHealth({ ...env, MAINTENANCE_TASKS: 'backup' } as Env, { now });
    assert.deepEqual(pending.findings.find(item => item.code === 'retention_raw_delete_pending')?.count, 2);
    // A forwarder replay of the retained local log brings one batch back before the retry.
    await fixture.ingest([record]);
    const resurrected = await batchOf(env, 'grace-1');
    const hourLater = new Date(now.getTime() + 3600_000);
    const retry = await backupTick(env, hourLater);
    assert.equal((retry.result as any).raw_deletes_retried, 1);
    assert.ok(await env.RAW.head(resurrected.r2_key), 'the live, resurrected batch keeps its raw object');
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM retention_run_objects WHERE raw_deleted_at IS NULL'), 1);
    const health = await dataHealth({ ...env, MAINTENANCE_TASKS: 'backup' } as Env, { now });
    assert.deepEqual(health.findings.find(item => item.code === 'resurrected_batch')?.sample_ids, [resurrected.id]);
    // The replayed batch is copied again, so a checkpoint taken after the run still restores completely.
    assert.equal((await env.DB.prepare('SELECT copied_at FROM backup_raw_objects WHERE batch_id=?').bind(resurrected.id).first<any>()).copied_at,
      hourLater.toISOString());
    const after = await completeCheckpoint(env, hourLater);
    assert.equal(after.raw_object_count, 1);
    const report = await drill(env, after);
    assert.equal(report.result, 'passed', JSON.stringify(report.failures));
    // Before the grace period the BACKUP copies stay; after it, only the non-resurrected copy goes.
    await backupTick(env, hourLater);
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM retention_run_objects WHERE backup_deleted_at IS NOT NULL'), 0);
    const graceEnd = new Date(Date.parse(run.run.backup_delete_after) + 60_000);
    const pruned = await backupTick(env, graceEnd);
    assert.equal((pruned.result as any).backup_copies_deleted, 1);
    const gone = keys.find(key => key !== resurrected.r2_key)!;
    assert.equal(await env.BACKUP!.head('raw/' + gone), null);
    assert.ok(await env.BACKUP!.head('raw/' + resurrected.r2_key));
    assert.equal((await env.DB.prepare('SELECT status FROM backup_raw_objects WHERE r2_key=?').bind(gone).first<any>()).status, 'deleted');
    assert.ok((await env.DB.prepare('SELECT raw_pruned_at FROM backup_checkpoints LIMIT 1').first<any>()).raw_pruned_at);
    const first = (await env.DB.prepare('SELECT * FROM backup_checkpoints ORDER BY started_at LIMIT 1').first<any>());
    assert.ok(first.raw_pruned_at, 'checkpoints that listed the deleted copies are marked pruned');
    assert.equal((await env.DB.prepare('SELECT raw_pruned_at FROM backup_checkpoints WHERE id=?').bind(after.id).first<any>()).raw_pruned_at, null,
      'a checkpoint started after the run never listed the deleted copy');
    const { checkpointView } = await import('../src/backup');
    assert.equal(checkpointView(first).retention_ready, false);
  } finally { await fixture.close(); }
});

test('live processing jobs and open flags block the batches they cite; finished jobs and closed flags release them; unreadable references fail closed', async () => {
  const fixture = await createEnvFixture({ backup: true });
  try {
    const env = fixture.env;
    const names = ['dismissed', 'flagged', 'summarized'];
    for (const name of names) await fixture.ingest([syntheticEvent('ref-' + name, { repo: 'ref-' + name, session: 'ref-' + name })]);
    await verifiedCheckpoint(env, later(15));
    await setPolicy(env, 'raw', 1);
    const now = later(2 * 24 * 60);
    const [dismissed, flagged, summarized] = await Promise.all(names.map(async name => (await fixture.event('ref-' + name))!));
    const blockedBy = async () => Object.fromEntries(((await retentionPlan(env, { now })).classes[0] as any).blocked_batches
      .map((item: any) => [item.batch_id, item.reasons]));
    // Migrations 0004 and 0007 are applied, so both checks always run; with no jobs or flags they hold nothing.
    const idle = await retentionPlan(env, { now });
    assert.deepEqual(idle.reference_checks, ['referenced_by_flag', 'referenced_by_processing']);
    assert.equal(idle.plan!.batch_ids.length, 3);
    // Real jobs from Track P's planner. The flagged project opts out, so only the flag cites its batch.
    await setProcessingPolicy(env, workspace);
    await setProcessingPolicy(env, { scope_type: 'project', scope_id: flagged.project_id }, { enabled: false });
    const plan = async (project: string) => {
      const [scope] = (await planRequest(env, { project_id: project }, reviewer, new Date())).scopes;
      assert.equal(scope.status, 'planned');
      return scope;
    };
    const first = (await plan(dismissed.project_id)).job_id!, second = (await plan(summarized.project_id)).job_id!;
    // Real Track R flags on an approved note (which cites the summarized event): an open one cites the
    // flagged event, a closed one the dismissed event. Only the open flag's evidence holds a batch.
    const note = await createContext(env, { kind: 'memory', project_id: summarized.project_id, title: 'Synthetic flagged note',
      content: 'Synthetic content only.', sources: [{ event_id: summarized.id, payload_hash: summarized.payload_hash }] }, 'approve');
    const flag = async (evidence: Record<string, any>) => {
      const response = await revisionsWrite(post(`/api/context/${note}/flags`, { kind: 'contradiction', note: 'Synthetic flag',
        evidence: [{ event_id: evidence.id, payload_hash: evidence.payload_hash }] }), env, reviewer);
      assert.equal(response!.status, 201, await response!.clone().text());
      return ((await response!.json()) as any).flag.id as string;
    };
    const resolve = async (id: string, resolution: 'resolved' | 'dismissed') => assert.equal((await revisionsWrite(post(`/api/context/flags/${id}/resolve`,
      { resolution, reason: 'Synthetic review' }), env, reviewer))!.status, 200);
    const openFlag = await flag(flagged);
    await resolve(await flag(dismissed), 'dismissed');
    const held = await retentionPlan(env, { now });
    assert.deepEqual(held.reference_checks, ['referenced_by_flag', 'referenced_by_processing']);
    assert.equal(held.plan, null);
    assert.deepEqual(await blockedBy(), { [dismissed.batch_id]: ['referenced_by_processing'], [flagged.batch_id]: ['referenced_by_flag'],
      [summarized.batch_id]: ['referenced_by_context', 'referenced_by_processing'] });
    // Track P's runner: the first job is leased by an invocation that runs out of allotment, then fails
    // every later attempt until it is failed; the second runs to a pending candidate.
    const stage: SelectionStage = async (input) => {
      if (input.scope.project_id !== dismissed.project_id) return ruleFilter(input);
      if (input.attempt === 1) throw new MaintenanceError('budget_exhausted:d1');
      throw new Error('synthetic stage failure');
    };
    const start = later(60), tick = (minutes: number) => runMaintenance({ ...env, MAINTENANCE_TASKS: 'processing' } as Env,
      { now: new Date(start.getTime() + minutes * 60_000), schedule: 'frequent', tasks: staged(stage) });
    const states = async () => [(await job(env, first)).status, (await job(env, second)).status];
    assert.equal((await tick(0)).processing.error, 'budget_exhausted:d1');
    assert.deepEqual(await states(), ['running', 'queued']);
    assert.deepEqual((await blockedBy())[dismissed.batch_id], ['referenced_by_processing']);
    // After the lease expires: the second job succeeds and the first fails its second attempt.
    await tick(11);
    assert.deepEqual(await states(), ['queued', 'succeeded']);
    // A succeeded job releases its hold; the note's and the generated candidate's citations still protect the batch.
    assert.deepEqual(await blockedBy(), { [dismissed.batch_id]: ['referenced_by_processing'], [flagged.batch_id]: ['referenced_by_flag'],
      [summarized.batch_id]: ['referenced_by_context'] });
    for (const minutes of [16, 46]) await tick(minutes);
    assert.deepEqual(await states(), ['failed', 'succeeded']);
    assert.deepEqual((await blockedBy())[dismissed.batch_id], ['referenced_by_processing'], 'a failed job still holds its sources');
    // A reviewer dismisses the failed job through Track P's route and resolves the flag.
    assert.equal((await processingWrite(post(`/api/processing/jobs/${first}/dismiss`, { reason: 'Synthetic dismissal' }), env, reviewer))!.status, 200);
    await resolve(openFlag, 'resolved');
    const open = (await retentionPlan(env, { now })).plan!;
    assert.deepEqual(new Set(open.batch_ids), new Set([dismissed.batch_id, flagged.batch_id]));
    assert.deepEqual(await blockedBy(), { [summarized.batch_id]: ['referenced_by_context'] });
    // New evidence after planning plans a new job that still cites the dismissed job's event: apply refuses.
    await fixture.ingest([syntheticEvent('ref-dismissed-2', { repo: 'ref-dismissed', session: 'ref-dismissed' })]);
    assert.equal((await plan(dismissed.project_id)).source_count, 2);
    const refused = await applyRetention(env, applyBody(open), reviewer, now);
    assert.equal(refused.status, 409);
    assert.deepEqual((await refused.json() as any).blocked, [{ batch_id: dismissed.batch_id, reasons: ['referenced_by_processing'] }]);
    // An unreadable reference must never read as "no references" (here, a flags table whose layout changed).
    await env.DB.prepare('ALTER TABLE context_flags RENAME COLUMN evidence TO evidence_unreadable').run();
    await assert.rejects(retentionPlan(env, { now }), status(503));
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM batches'), 4);
  } finally { await fixture.close(); }
});

test('without migration 0004 retention plans and applies with no processing check, and a foreign layout fails closed', async () => {
  // Explicitly the schema of a deployment that applied Track D but never Track P (nor Track R, whose flags build on it).
  const fixture = await createEnvFixture({ backup: true, migrations: await migrationsExcept('0004', '0007') });
  try {
    const env = fixture.env;
    await fixture.ingest([syntheticEvent('legacy-1')]);
    await verifiedCheckpoint(env, later(15));
    await setPolicy(env, 'raw', 1);
    const now = later(2 * 24 * 60);
    const planned = await retentionPlan(env, { now });
    assert.deepEqual(planned.reference_checks, []);
    assert.equal(planned.plan!.batch_ids.length, 1);
    // Tables of those names with another layout fail closed instead of reading as "no references".
    await env.DB.batch([env.DB.prepare('CREATE TABLE processing_jobs(id TEXT PRIMARY KEY, state TEXT)'),
      env.DB.prepare('CREATE TABLE processing_job_sources(job_id TEXT, event_id TEXT)')]);
    await assert.rejects(retentionPlan(env, { now }), status(503));
    await assert.rejects(applyRetention(env, applyBody(planned.plan), reviewer, now), status(503));
    await env.DB.batch([env.DB.prepare('DROP TABLE processing_job_sources'), env.DB.prepare('DROP TABLE processing_jobs')]);
    const applied = await applyRetention(env, applyBody(planned.plan), reviewer, now);
    assert.equal(applied.status, 201, await applied.clone().text());
    assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM batches'), 0);
  } finally { await fixture.close(); }
});

test('the bundled Worker applies a reviewed retention plan end to end', async () => {
  const worker = await operationsWorker({ MAINTENANCE_TASKS: 'backup' });
  try {
    for (const id of ['http-1', 'http-2']) assert.equal((await worker.upload([syntheticEvent(id, { session: id })])).status, 200);
    assert.equal((await (await worker.mf.getWorker()).scheduled({ cron: '17 * * * *', scheduledTime: later(15) })).outcome, 'ok');
    const checkpoint = (await latestCheckpoint(worker.env))!;
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => worker.mf.dispatchFetch(String(input), init as never)) as unknown as typeof fetch;
    const source = httpSource(new URL('http://localhost'), operationsTokens.review, checkpoint.id, fetcher);
    const workDir = await mkdtemp(join(tmpdir(), 'beacon-retention-drill-'));
    try {
      const report = await restoreCheck({ checkpointId: checkpoint.id, source, expectedManifestSha256: await source.manifestSha256(), workDir });
      assert.equal((await worker.write(`/api/backups/${checkpoint.id}/verify`, verifyRequest(report))).status, 200);
    } finally { await rm(workDir, { recursive: true, force: true }); }
    assert.equal((await worker.write('/api/retention/policies', { data_class: 'raw', keep_days: 1 }, operationsTokens.read)).status, 403);
    assert.equal((await worker.write('/api/retention/policies', { data_class: 'raw', keep_days: 1 })).status, 200);
    // Age the synthetic batches past the keep window; backup coverage still holds because they settled before the snapshot.
    await worker.env.DB.prepare('UPDATE batches SET received_at=?').bind(new Date(Date.now() - 3 * DAY).toISOString()).run();
    const planned = await (await worker.bearer('/api/retention/plan', operationsTokens.read)).json() as any;
    assert.equal(planned.plan.batch_ids.length, 2);
    for (const token of [operationsTokens.read, operationsTokens.mcp, operationsTokens.mbp])
      assert.equal((await worker.write('/api/retention/apply', applyBody(planned.plan), token)).status, 403);
    const applied = await worker.write('/api/retention/apply', applyBody(planned.plan));
    assert.equal(applied.status, 201, await applied.clone().text());
    assert.equal((await applied.json() as any).raw_deleted, true);
    assert.equal(((await (await worker.bearer('/api/retention/plan', operationsTokens.read)).json()) as any).plan, null);
    assert.equal(((await (await worker.bearer('/api/sessions', operationsTokens.read)).json()) as any).sessions.length, 2);
    assert.equal((await worker.write('/api/retention/apply', applyBody(planned.plan))).status, 409);
  } finally { await worker.close(); }
});
