import test from 'node:test';
import assert from 'node:assert/strict';
import { getContext, insertCandidate, listContext } from '../src/context';
import { validateGenerated } from '../src/generator';
import { runMaintenance } from '../src/maintenance';
import { PROCESSING_ALLOTMENT, processingMaintenance, processingRead, processingTick, processingWrite } from '../src/processing';
import { getEventVersion } from '../src/queries';
import { Env } from '../src/types';
import { createEnvFixture, syntheticEvent } from './env-fixture';
import { at, command, count, jobs, later, newTask, post, rejects, review, reviewer, run, setPolicy, tick, workspace } from './processing-helpers';

test('extractive citations resolve to persisted exact versions; non-matching captures are excluded and counted', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, { summary_fields: ['command_text', 'file_path'] });
    await f.ingest([command('cite-1', 'npm test', 1, { timestamp: at(1) }),
      syntheticEvent('cite-2', { action: 'file.modified', timestamp: at(2), extra: { file: { path: '/synthetic/alpha/src/login.ts' } } }),
      command('cite-3', 'npm test', 0, { timestamp: at(3) }), syntheticEvent('cite-drop', { timestamp: at(4) })]);
    // An alternate capture of cite-1 claims another repository; it must never be cited.
    await f.ingest(command('cite-1', 'npm test', 1, { timestamp: at(1), repo: 'forged-repo', session: 'forged-session' }));
    const indexed = (await f.event('cite-1'))!;
    assert.equal(await count(f.env, 'event_versions WHERE event_id=?', indexed.id), 2);
    // No stored version of cite-drop matches its index row any more.
    await f.env.DB.prepare('UPDATE events SET harness=? WHERE event_id=?').bind('synthetic_other', 'cite-drop').run();
    await tick(f.env);
    const [done] = await jobs(f.env);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.source_count, 4); assert.equal(done.event_count, 3); assert.equal(done.excluded_count, 1);
    assert.equal(await count(f.env, 'processing_coverage WHERE job_id=?', done.id), 4);
    assert.match(done.input_hash, /^[a-f0-9]{64}$/);
    const context: any = (await getContext(f.env, done.result_context_id)).context;
    assert.equal(validateGenerated({ title: context.title, content: context.content, sources: context.sources }), null);
    const cited = new Set([...context.content.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
    assert.deepEqual([...cited].sort(), [1, 2, 3]);
    assert.equal(context.source_count, 3);
    for (const source of context.sources) {
      const version = await getEventVersion(f.env, source.event_id, new URLSearchParams({ payload_hash: source.payload_hash }));
      assert.equal(version.event.scope_matches_index, true);
    }
    assert.equal(context.sources.find((source: any) => source.event_id === indexed.id).payload_hash, indexed.payload_hash);
    const dropped = (await f.event('cite-drop'))!.id;
    assert.ok(!context.sources.some((source: any) => source.event_id === dropped));
    assert.ok(context.content.includes('src/login.ts'));
    assert.match(context.content, /先前失敗後已成功：「npm test」/);
    // When the planned (first indexed) version stops matching its index row, another stored
    // version that does match is cited instead of it.
    const forged = (await f.env.DB.prepare("SELECT id,project_id FROM sessions WHERE source_session_id='forged-session'").first<any>())!;
    await f.env.DB.prepare('UPDATE events SET session_id=?,project_id=? WHERE id=?').bind(forged.id, forged.project_id, indexed.id).run();
    await tick(f.env, later(130));
    const moved = (await jobs(f.env)).find((row: any) => row.project_id === forged.project_id);
    assert.equal(moved.status, 'succeeded'); assert.equal(moved.excluded_count, 0);
    const alternate: any = (await getContext(f.env, moved.result_context_id)).context;
    assert.equal(alternate.sources.length, 1);
    assert.notEqual(alternate.sources[0].payload_hash, indexed.payload_hash);
    const version = await getEventVersion(f.env, indexed.id, new URLSearchParams({ payload_hash: alternate.sources[0].payload_hash }));
    assert.equal(version.event.scope_matches_index, true);
  } finally { await f.close(); }
});

test('pipeline candidates stay pending under a pipeline actor that cannot review; exclusions hold in the output', async () => {
  const f = await createEnvFixture({ bindings: { REVIEW_TOKEN: 'synthetic-review-token-value-0000' } });
  try {
    // Metadata only: no paths, commands, tool names or titles in the candidate.
    await setPolicy(f.env, workspace);
    await f.ingest([command('meta-1', 'deploy --token=synthetic-review-token-value-0000', 2, { timestamp: at(1) }),
      syntheticEvent('meta-2', { action: 'file.modified', timestamp: at(2), extra: { file: { path: '/Users/synthalice/private/plan-secret.md' } } }),
      syntheticEvent('meta-3', { action: 'approval.denied', timestamp: at(3), extra: { approval: { decision: 'denied' }, tool: { name: 'SyntheticToolName' } } }),
      syntheticEvent('meta-4', { action: 'session.started', timestamp: at(4) })]);
    await tick(f.env);
    const [done] = await jobs(f.env);
    const context: any = (await getContext(f.env, done.result_context_id)).context;
    assert.equal(context.status, 'pending'); assert.equal(context.authoritative, false);
    assert.equal(context.kind, 'summary'); assert.equal(context.supersedes_id, null); assert.equal(context.task_id, null);
    assert.equal(context.origin, 'pipeline');
    assert.deepEqual(context.generation, { job_id: done.id, processor: 'beacon.extractive.v1', previous_context_id: null });
    assert.deepEqual(context.audit.map((row: any) => [row.action, row.actor]), [['create', 'pipeline:beacon.extractive@1']]);
    assert.match(context.title, /^自動整理：專案 [a-f0-9]{8}（2026-10-07）$/);
    for (const hidden of ['plan-secret', 'synthalice', 'deploy', 'synthetic-review-token', 'SyntheticToolName', 'alpha'])
      assert.ok(!(context.title + context.content).includes(hidden), hidden);
    assert.match(context.content, /副檔名：\.md/);
    assert.match(context.content, /approval\.denied：拒絕/);
    assert.match(context.content, /失敗（結束碼 2）/);
    // The database refuses review by any pipeline actor, whatever the code path.
    for (const status of ['approved', 'rejected'])
      await assert.rejects(f.env.DB.prepare(`UPDATE context_entries SET status=?,review_id=?,reviewed_at=?,reviewed_by=? WHERE id=?`)
        .bind(status, crypto.randomUUID(), at(9), 'pipeline:beacon.extractive@1', context.id).run(), /context_review_forbidden/);
    await assert.rejects(f.env.DB.prepare('DELETE FROM context_generation').run(), /context_immutable/);
    await assert.rejects(f.env.DB.prepare('UPDATE context_generation SET processor=?').bind('forged').run(), /context_immutable/);
    // A manual candidate cannot be relabelled as pipeline output.
    const manual = await insertCandidate(f.env, { kind: 'summary', project_id: context.project_id, title: 'Manual synthetic',
      content: 'Manual synthetic content.', sources: [{ event_id: context.sources[0].event_id, payload_hash: context.sources[0].payload_hash }] }, reviewer);
    await assert.rejects(f.env.DB.prepare(`INSERT INTO context_generation(context_id,job_id,processor,scope_key,created_at) VALUES(?,?,?,?,?)`)
      .bind(manual, '0'.repeat(64), 'beacon.extractive.v1', done.scope_key, at(9)).run(), /context_generation_invalid/);
    assert.equal((await getContext(f.env, manual)).context.origin, 'manual');
    assert.equal((await getContext(f.env, manual)).context.generation, null);
    assert.equal((await listContext(f.env, new URLSearchParams('status=pending'))).context.find((row) => row.id === context.id)!.origin, 'pipeline');
    await review(f.env, context.id, 'approve');
    assert.equal((await getContext(f.env, context.id)).context.authoritative, true);
    // The next summary of the scope is rebuilt from raw evidence and chained, not superseding.
    await f.ingest(command('meta-5', 'npm test', 0, { timestamp: at(5) }));
    await tick(f.env, later(130));
    const chained: any = (await getContext(f.env, (await jobs(f.env)).at(-1).result_context_id)).context;
    assert.equal(chained.generation.previous_context_id, context.id);
    assert.equal(chained.supersedes_id, null);
    assert.equal(chained.source_count, 1);
    assert.equal((await getContext(f.env, context.id)).context.status, 'approved');
  } finally { await f.close(); }
});

test('the rule filter skips low-signal-only sources and covers them; jobs without matching versions skip too', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace);
    await f.ingest([syntheticEvent('low-1', { action: 'session.started', timestamp: at(1) }),
      syntheticEvent('low-2', { action: 'session.heartbeat', timestamp: at(2) }), syntheticEvent('low-3', { action: 'session.ended', timestamp: at(3) })]);
    await tick(f.env);
    const [low] = await jobs(f.env);
    assert.equal(low.status, 'skipped'); assert.equal(low.skip_reason, 'low_signal_only');
    assert.equal(await count(f.env, 'processing_coverage WHERE job_id=?', low.id), 3);
    assert.equal(await count(f.env, 'context_entries'), 0);
    await f.ingest(syntheticEvent('nomatch-1', { timestamp: at(5) }));
    await f.env.DB.prepare('UPDATE events SET harness=? WHERE event_id=?').bind('synthetic_other', 'nomatch-1').run();
    await tick(f.env, later(130));
    const empty = (await jobs(f.env)).at(-1);
    assert.equal(empty.skip_reason, 'no_matching_versions'); assert.equal(empty.excluded_count, 1);
    assert.equal(await count(f.env, 'processing_coverage WHERE job_id=?', empty.id), 1);
  } finally { await f.close(); }
});

test('a busy tick stays inside its allotment: five scopes planned, two whole jobs run, the rest wait', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, { summary_fields: ['command_text'] });
    for (let repo = 0; repo < 7; repo++) {
      await f.ingest(Array.from({ length: 30 }, (_, index) => command(`busy-${repo}-${index}`, index % 5 ? 'npm test' : 'npm run build',
        index % 7 ? 0 : 1, { repo: `repo-${repo}`, session: `session-${repo}`, timestamp: at(index) })));
    }
    const first = await tick(f.env, later(60));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.scanned, 5); assert.equal(first.result.planned, 5);
    assert.deepEqual(first.result.run_outcomes, { succeeded: 2 });
    for (const kind of ['d1', 'r2', 'fetch'] as const) assert.ok(first.usage[kind] <= PROCESSING_ALLOTMENT[kind], kind);
    assert.equal(first.usage.fetch, 0);
    const second = await tick(f.env, later(61));
    // The cursor rotates on to the two scopes not yet seen, then wraps around.
    assert.equal(second.result.scanned, 5);
    assert.equal(second.result.planned, 2);
    for (const kind of ['d1', 'r2', 'fetch'] as const) assert.ok(second.usage[kind] <= PROCESSING_ALLOTMENT[kind], kind);
    // Without room for a whole job the runner stops before claiming instead of failing half way.
    const tight = await runMaintenance({ ...f.env, MAINTENANCE_TASKS: 'processing' } as Env, { now: later(62), tasks: [{
      ...processingMaintenance[0], run: (env, ctx) => processingTick(env, { ...ctx, usage: () => ({ ...ctx.usage(), r2: 590 }) }) }] });
    assert.equal(tight.processing.ok, true);
    assert.equal((tight.processing.result as any).stopped, 'allotment');
    assert.equal((tight.processing.result as any).claimed, 0);
    let queued = 99;
    for (let round = 0; round < 6 && queued; round++) {
      await tick(f.env, later(63 + round));
      queued = await count(f.env, "processing_jobs WHERE status='queued'");
    }
    assert.equal(queued, 0);
    assert.equal(await count(f.env, "processing_jobs WHERE status='succeeded'"), 7);
  } finally { await f.close(); }
});

test('ingest acknowledgements do not depend on processing tables, even when they are dropped', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace);
    await f.ingest(syntheticEvent('drop-1'));
    await tick(f.env);
    for (const table of ['processing_job_fence', 'processing_coverage', 'processing_job_sources', 'processing_signals', 'processing_calls',
      'processing_job_audit', 'context_generation', 'processing_jobs', 'processing_policy_audit', 'processing_policies',
      'processing_budget_audit', 'processing_budget', 'processing_scan_cursor'])
      await f.env.DB.prepare(`DROP TABLE ${table}`).run();
    const ack = await f.ingest([syntheticEvent('drop-2'), syntheticEvent('drop-3', { session: 'session-c' })], 'mini');
    assert.equal(ack.accepted, 2); assert.equal(ack.inserted, 2);
    const report = await tick(f.env);
    assert.equal(report.ok, false); assert.equal(report.error, 'task_failed');
    assert.equal((await f.ingest(syntheticEvent('drop-4'))).accepted, 1);
    assert.equal(await count(f.env, 'events'), 4);
  } finally { await f.close(); }
});

test('job reads list identifiers, codes and counts only, with filters and keyset pages', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, { summary_fields: ['command_text'] });
    for (let repo = 0; repo < 3; repo++)
      await f.ingest(command(`list-${repo}`, `echo MARKER_CONTENT_${repo}`, 0, { repo: `list-${repo}`, session: `s-${repo}` }));
    await tick(f.env);
    const read = async (path: string) => (await processingRead(new Request('http://localhost' + path), f.env))!.json() as Promise<any>;
    const all = await read('/api/processing/jobs');
    assert.equal(all.jobs.length, 3); assert.equal(all.next_cursor, null);
    assert.ok(!JSON.stringify(all).includes('MARKER_CONTENT'));
    const page = await read('/api/processing/jobs?limit=2');
    assert.equal(page.jobs.length, 2);
    const rest = await read('/api/processing/jobs?limit=2&before=' + encodeURIComponent(page.next_cursor));
    assert.equal(rest.jobs.length, 1);
    assert.equal(new Set([...page.jobs, ...rest.jobs].map((row: any) => row.id)).size, 3);
    const succeeded = all.jobs.filter((row: any) => row.status === 'succeeded');
    assert.equal(succeeded.length, 2);
    assert.equal((await read('/api/processing/jobs?status=succeeded')).jobs.length, 2);
    assert.equal((await read('/api/processing/jobs?status=queued')).jobs.length, 1);
    assert.equal((await read('/api/processing/jobs?project_id=' + all.jobs[0].project_id)).jobs.length, 1);
    const detail = (await read('/api/processing/jobs/' + succeeded[0].id)).job;
    assert.equal(detail.covered_count, 1); assert.equal(detail.sources.length, 1); assert.equal(detail.sources[0].covered, true);
    assert.equal(detail.result_status, 'pending');
    assert.deepEqual([detail.signals, detail.calls, detail.audit], [[], [], []]);
    assert.ok(!JSON.stringify(detail).includes('MARKER_CONTENT'));
    for (const path of ['/api/processing/jobs?status=all', '/api/processing/jobs?limit=41', '/api/processing/jobs?before=bad',
      '/api/processing/jobs?project_id=x', '/api/processing/jobs?task_id=x', '/api/processing/jobs?unknown=1',
      '/api/processing/jobs?status=queued&status=failed', '/api/processing/jobs/not-a-job', `/api/processing/jobs/${succeeded[0].id}?x=1`])
      await rejects(processingRead(new Request('http://localhost' + path), f.env), 400);
    await rejects(processingRead(new Request('http://localhost/api/processing/jobs/' + '0'.repeat(64)), f.env), 404);
    for (const body of [{}, { task_id: crypto.randomUUID(), project_id: all.jobs[0].project_id }, { task_id: 'x' }, { project_id: 'x' }, { other: 1 }])
      await rejects(processingWrite(post('/api/processing/run', body), f.env, reviewer), 400);
    await rejects(processingWrite(post('/api/processing/run', { task_id: crypto.randomUUID() }), f.env, reviewer), 404);
    // A task without linked sessions has no scope to plan.
    assert.deepEqual(await run(f.env, { task_id: await newTask(f.env, 'Synthetic empty task') }), { scopes: [] });
    await rejects(processingWrite(post('/api/processing/run', { project_id: 'e'.repeat(64) }), f.env, reviewer), 404);
    // Budget and usage routes belong to part B; until then they are not served.
    assert.equal(await processingWrite(post('/api/processing/budget', {}), f.env, reviewer), null);
    assert.equal(await processingRead(new Request('http://localhost/api/processing/usage'), f.env), null);
    assert.equal(await processingWrite(post('/api/context', {}), f.env, reviewer), null);
  } finally { await f.close(); }
});

test('acceptance: a labelled two-Mac task cites every failure, fix, verification, decision and open risk', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, { summary_fields: ['command_text', 'file_path', 'tool_name', 'titles'] });
    const labelled = {
      failure: command('acc-mbp-fail', 'npm test -- login', 1, { session: 'mbp-login', timestamp: at(10) }),
      fix: syntheticEvent('acc-mbp-fix', { action: 'file.modified', session: 'mbp-login', timestamp: at(20),
        extra: { file: { path: '/synthetic/alpha/src/auth/callback.ts' } } }),
      decision: syntheticEvent('acc-mbp-approval', { action: 'approval.allowed', session: 'mbp-login', timestamp: at(30),
        extra: { approval: { decision: 'allowed' }, tool: { name: 'Bash' } } }),
      verification: command('acc-mini-verify', 'npm test -- login', 0, { session: 'mini-verify', timestamp: at(40) }),
      risk: command('acc-mini-lint', 'npm run lint', 2, { session: 'mini-verify', timestamp: at(50) }),
    };
    const noise = [syntheticEvent('acc-mbp-start', { action: 'session.started', session: 'mbp-login', timestamp: at(1) }),
      syntheticEvent('acc-mbp-read', { action: 'file.read', session: 'mbp-login', timestamp: at(15),
        extra: { file: { path: '/synthetic/alpha/README.md' } } })];
    await f.ingest([...noise, labelled.failure, labelled.fix, labelled.decision]);
    await f.ingest([labelled.verification, labelled.risk], 'mini');
    const sessions = [(await f.event('acc-mbp-fail'))!.session_id, (await f.event('acc-mini-verify'))!.session_id];
    const taskId = await newTask(f.env, '合成：修復登入並跨機驗證', sessions);
    const planned = await run(f.env, { task_id: taskId });
    assert.deepEqual(planned.scopes.map((scope: any) => scope.status), ['planned']);
    await tick(f.env);
    const [done] = await jobs(f.env);
    assert.equal(done.status, 'succeeded'); assert.equal(done.task_id, taskId);
    const context: any = (await getContext(f.env, done.result_context_id)).context;
    assert.equal(context.task_id, taskId);
    assert.equal(context.title, '自動整理：合成：修復登入並跨機驗證（2026-10-07）');
    const numberOf = async (id: string) => {
      const central = (await f.event(id))!.id;
      return context.sources.findIndex((source: any) => source.event_id === central) + 1;
    };
    const section = (heading: string) => context.content.split('\n\n').find((part: string) => part.startsWith(heading))!;
    const expectations: [keyof typeof labelled, string][] = [['failure', '## 進度'], ['fix', '## 進度'], ['decision', '## 決策'],
      ['verification', '## 已驗證結果'], ['risk', '## 待辦與風險']];
    const found: Record<string, number> = {};
    for (const [label, heading] of expectations) {
      const n = await numberOf(labelled[label].event.id);
      assert.ok(n > 0, `${label} is a persisted source`);
      assert.ok(section(heading).includes(`[${n}]`), `${label} is cited under ${heading}`);
      found[label] = n;
    }
    assert.match(section('## 進度'), /2 台裝置（mbp、mini）、2 個 session/);
    assert.match(section('## 進度'), /src\/auth\/callback\.ts/);
    assert.match(section('## 進度'), /先前失敗後已成功：「npm test -- login」/);
    assert.match(section('## 已驗證結果'), /「npm test -- login」結束碼 0/);
    assert.match(section('## 決策'), /approval\.allowed：允許（Bash）/);
    assert.match(section('## 待辦與風險'), /「npm run lint」失敗（結束碼 2）/);
    assert.match(section('## 待辦與風險'), /任務仍為進行中/);
    assert.equal(validateGenerated({ title: context.title, content: context.content, sources: context.sources }), null);
    // Counts recorded for VALIDATION.md.
    const cited = new Set([...context.content.matchAll(/\[(\d+)\]/g)].map((match) => match[1]));
    console.log(JSON.stringify({ acceptance: { events: done.event_count, sources: context.source_count, cited: cited.size,
      labelled: Object.keys(labelled).length, labelled_cited: Object.keys(found).length, content_chars: context.content.length } }));
    assert.equal(Object.keys(found).length, 5);
  } finally { await f.close(); }
});
