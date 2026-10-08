import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { insertCandidate } from '../src/context';
import { extractiveGenerator, Generator } from '../src/generator';
import worker from '../src/index';
import { runMaintenance } from '../src/maintenance';
import { processingMaintenance, processingRead, processingTick } from '../src/processing';
import { effectivePolicy, EffectivePolicy } from '../src/processing-policy';
import { makeScope } from '../src/processing-planner';
import type { SelectionStage, StageResult } from '../src/processing-stage';
import { projectEvents } from '../src/privacy';
import { defaultStage, jevStage } from '../src/jev';
import { Env } from '../src/types';
import { createEnvFixture, syntheticEvent } from './env-fixture';
import { command, count, job, jobs, newTask, review, reviewer, run, setBudget, setPolicy, tick, workspace } from './processing-helpers';

const key = 'synthetic-jev-key-not-real-0000000000';
const reviewToken = 'synthetic-review-token-value-00000000';
const external = { external_allowed: true, jev_enabled: true, summary_fields: ['command_text', 'titles'], external_fields: ['titles'],
  min_new_events: 1000 };
const gated = (env: Env, extra: Partial<Env> = {}) => ({ ...env, EXTERNAL_PROCESSING_PROJECTS: '*', JEV_API_KEY: key, ...extra }) as Env;
/** A fixed future UTC noon, so every reservation in one test lands on the same ledger day; read it once per test. */
const noon = () => new Date(Math.ceil((Date.now() + 3 * 3_600_000) / 86_400_000) * 86_400_000 + 12 * 3_600_000);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
type Fixture = Awaited<ReturnType<typeof createEnvFixture>>;
type Seen = { url: string; init: RequestInit; text: string; body: any };

/** A synthetic Jev: records every request and answers each asked question unless told otherwise. */
function fakeJev(answer?: (body: any, seen: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const text = String(init.body), seen = { url: String(input), init, text, body: JSON.parse(text) };
    calls.push(seen);
    return answer ? answer(seen.body, seen) : Response.json({ answers: Object.fromEntries(Object.keys(seen.body.questions)
      .map((id) => [id, { type: 'noul', noul: 0.5, confidence: 0.5 }])), usage: { input_tokens: 400, output_tokens: 6 } });
  }) as typeof fetch;
  return { calls, fetcher };
}
async function approvedNote(f: Fixture, eventId: string, title: string, content: string, taskId?: string) {
  const event = (await f.event(eventId))!;
  const id = await insertCandidate(f.env, { kind: 'memory', project_id: event.project_id, ...(taskId ? { task_id: taskId } : {}), title, content,
    sources: [{ event_id: event.id, payload_hash: event.payload_hash }] }, reviewer);
  await review(f.env, id, 'approve');
  return id;
}
const read = async (env: Env, path: string) => (await processingRead(new Request('http://localhost' + path), env))!.json() as Promise<any>;
const hasAny = (value: unknown, needles: string[]) => needles.filter((needle) => JSON.stringify(value).includes(needle));

test('end to end, a tick calls Jev only when every condition holds, also after a policy is revoked and restored', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, external);
    const jev = fakeJev();
    let clock = noon();
    const scenario = async (name: string, env: Env, project?: Record<string, unknown>) => {
      await f.ingest(command(`${name}-1`, 'npm test', 0, { repo: name, session: `${name}-session` }));
      const event = (await f.event(`${name}-1`))!;
      if (project) await setPolicy(f.env, { scope_type: 'project', scope_id: event.project_id }, { ...external, ...project });
      const taskId = await newTask(f.env, `合成任務 ${name}`, [event.session_id]);
      const planned = (await run(f.env, { task_id: taskId })).scopes[0];
      assert.equal(planned.status, 'planned', name);
      const before = jev.calls.length;
      clock = new Date(clock.getTime() + 60_000);
      const report = await tick(env, clock, { fetcher: jev.fetcher });
      assert.equal(report.ok, true, name + JSON.stringify(report));
      const fetched = jev.calls.length - before;
      assert.equal(report.usage.fetch, fetched, name);
      const row = await job(f.env, planned.job_id);
      return { fetched, row, calls: await count(f.env, 'processing_calls WHERE job_id=?', planned.job_id) };
    };
    const blocked = async (name: string, env: Env, project?: Record<string, unknown>, note: string | null = null) => {
      const result = await scenario(name, env, project);
      assert.deepEqual([result.fetched, result.calls, result.row.status, result.row.note], [0, 0, 'succeeded', note], name);
    };
    // Every condition holds except a budget: the reservation is refused and nothing is sent.
    await blocked('no-budget', gated(f.env), undefined, 'jev_budget:budget_disabled');
    await setBudget(f.env, { daily_call_limit: 2 });
    const allowed = await scenario('allowed', gated(f.env));
    assert.deepEqual([allowed.fetched, allowed.calls, allowed.row.status, allowed.row.note], [1, 1, 'succeeded', null]);
    assert.deepEqual(Object.keys(jev.calls[0].body.questions), ['task_related']);
    assert.equal(jev.calls[0].body.state.scope.task_title, '合成任務 allowed');
    // A project row narrowing the workspace is read from D1 at run time.
    await blocked('project-external-off', gated(f.env), { external_allowed: false });
    // Revoked between planning and running: the job ends policy_changed before any call;
    // restoring the identical policy re-queues the same job, which then may call.
    await f.ingest(command('revoked-1', 'npm test', 0, { repo: 'revoked', session: 'revoked-session' }));
    const revokedTask = await newTask(f.env, '合成任務 revoked', [(await f.event('revoked-1'))!.session_id]);
    const revoked = (await run(f.env, { task_id: revokedTask })).scopes[0];
    await setPolicy(f.env, workspace, { ...external, jev_enabled: false });
    const before = jev.calls.length;
    await tick(gated(f.env), new Date(clock.getTime() + 60_000), { fetcher: jev.fetcher });
    assert.deepEqual([jev.calls.length - before, (await job(f.env, revoked.job_id)).skip_reason], [0, 'policy_changed']);
    await setPolicy(f.env, workspace, external);
    assert.deepEqual((await run(f.env, { task_id: revokedTask })).scopes.map((scope: any) => [scope.status, scope.job_id]), [['requeued', revoked.job_id]]);
    await tick(gated(f.env), new Date(clock.getTime() + 120_000), { fetcher: jev.fetcher });
    assert.deepEqual([jev.calls.length - before, (await job(f.env, revoked.job_id)).status], [1, 'succeeded']);
    clock = new Date(clock.getTime() + 180_000);
    // Two calls already counted today: a limit of two refuses the third reservation.
    await blocked('day-exhausted', gated(f.env), undefined, 'jev_budget:daily_call_limit');
    assert.equal(jev.calls.length, 2);
    assert.equal(await count(f.env, 'processing_calls'), 2);
  } finally { await f.close(); }
});

test('each gate condition alone keeps the stage from reserving budget or sending anything', async () => {
  const f = await createEnvFixture();
  try {
    const fields = { summary_fields: ['command_text', 'titles', 'approved_note_text'], external_fields: ['titles', 'approved_note_text'] };
    await setPolicy(f.env, workspace, { ...external, ...fields });
    await setBudget(f.env, { daily_call_limit: 50 });
    await f.ingest(command('gate-1', 'npm test', 1, { repo: 'gate', session: 'gate-session' }));
    const event = (await f.event('gate-1'))!;
    const taskId = await newTask(f.env, '合成任務 gate', [event.session_id]);
    const planned = (await run(f.env, { task_id: taskId })).scopes[0];
    const now = noon();
    await f.env.DB.prepare(`UPDATE processing_jobs SET status='running',attempts=1,lease_owner='gate-owner',lease_until=? WHERE id=?`)
      .bind(new Date(now.getTime() + 600_000).toISOString(), planned.job_id).run();
    const allowed = await effectivePolicy(f.env, event.project_id);
    const scope = await makeScope('task', taskId, event.project_id);
    const jev = fakeJev();
    // The stage's input exactly as the runner builds it from this job's one source.
    const sources = [{ payload: command('gate-1', 'npm test', 1, { repo: 'gate', session: 'gate-session' }), timestamp: '2026-10-07T08:00:00.000Z' }];
    const projection = projectEvents(sources, allowed.summary_fields).events;
    const attempt = (env: Env, options: { policy?: Partial<EffectivePolicy>; owner?: string; remaining?: number; taskTitle?: string | null } = {}) =>
      jevStage({ env, ctx: { now, remaining: () => options.remaining ?? 20_000, usage: () => ({ d1: 0, r2: 0, fetch: 0 }), fetch: jev.fetcher },
        job_id: planned.job_id, attempt: 1, lease_owner: options.owner ?? 'gate-owner', scope, policy: { ...allowed, ...options.policy }, projection,
        reproject: (fields, assigned) => projectEvents(sources, fields, { assigned }),
        labels: { task_title: options.taskTitle === undefined ? '合成任務 gate' : options.taskTitle, project_name: 'gate' } });
    const expectBlocked = async (name: string, result: Promise<StageResult>, note?: string) => {
      assert.deepEqual(await result, { decision: 'continue', signals: [], ...(note ? { note } : {}) }, name);
      assert.deepEqual([jev.calls.length, await count(f.env, 'processing_calls')], [0, 0], name);
    };
    await expectBlocked('no deploy var', attempt(gated(f.env, { EXTERNAL_PROCESSING_PROJECTS: undefined })));
    await expectBlocked('another project listed', attempt(gated(f.env, { EXTERNAL_PROCESSING_PROJECTS: 'f'.repeat(64) })));
    await expectBlocked('no key', attempt(gated(f.env, { JEV_API_KEY: undefined })));
    await expectBlocked('empty key', attempt(gated(f.env, { JEV_API_KEY: '' })));
    await expectBlocked('insecure endpoint', attempt(gated(f.env, { JEV_ENDPOINT: 'http://jev.example.invalid/v1/systemone' })));
    await expectBlocked('endpoint on this Worker', attempt(gated(f.env, { PUBLIC_URL: 'https://beacon.example.invalid',
      JEV_ENDPOINT: 'https://beacon.example.invalid/api/jev' })));
    await expectBlocked('invalid model', attempt(gated(f.env, { JEV_MODEL: 'jev latest' })));
    await expectBlocked('external not allowed', attempt(gated(f.env), { policy: { external_allowed: false } }));
    await expectBlocked('jev not enabled', attempt(gated(f.env), { policy: { jev_enabled: false } }));
    await expectBlocked('processing disabled', attempt(gated(f.env), { policy: { enabled: false } }));
    await expectBlocked('no external fields', attempt(gated(f.env), { policy: { external_fields: [] } }));
    // Titles alone need a task title; note text alone needs at least one approved note.
    await expectBlocked('titles without a task title', attempt(gated(f.env), { policy: { external_fields: ['titles'] }, taskTitle: null }));
    await expectBlocked('note text without notes', attempt(gated(f.env), { policy: { external_fields: ['approved_note_text'] } }));
    await expectBlocked('no time left', attempt(gated(f.env), { remaining: 2500 }), 'jev_no_time');
    // Time for a shortened call is not enough: the whole 5 s timeout plus 2 s must fit.
    await expectBlocked('no time for the whole timeout', attempt(gated(f.env), { remaining: 6_999 }), 'jev_no_time');
    await expectBlocked('lease held elsewhere', attempt(gated(f.env), { owner: 'other-owner' }), 'jev_budget:lease_lost');
    for (const [name, limits, note] of [['zero calls', { daily_call_limit: 0 }, 'jev_budget:budget_disabled'],
      ['zero tokens', { daily_token_limit: 0 }, 'jev_budget:budget_disabled'], ['token limit below one call', { daily_token_limit: 100 }, 'jev_budget:daily_token_limit'],
      ['zero USD ceiling', { daily_usd_ceiling: 0 }, 'jev_budget:usd_ceiling']] as const) {
      await setBudget(f.env, { daily_call_limit: 50, ...limits });
      await expectBlocked(name, attempt(gated(f.env)), note);
    }
    // With every condition met, and just enough time, exactly one request goes out; the job never sends a second.
    await setBudget(f.env, { daily_call_limit: 50 });
    assert.deepEqual(await attempt(gated(f.env), { remaining: 7_000 }), { decision: 'continue', signals: [] });
    assert.deepEqual(Object.keys(jev.calls[0].body.questions), ['task_related']);
    assert.deepEqual(await attempt(gated(f.env)), { decision: 'continue', signals: [] });
    assert.deepEqual([jev.calls.length, await count(f.env, 'processing_calls'), await count(f.env, 'processing_signals')], [1, 1, 1]);
  } finally { await f.close(); }
});

test('the request carries only external fields, redacted, with this project\'s authoritative notes; answers are stored uncalibrated', async () => {
  const f = await createEnvFixture({ bindings: { REVIEW_TOKEN: reviewToken } });
  try {
    await setPolicy(f.env, workspace, { ...external, summary_fields: ['command_text', 'file_path', 'titles', 'approved_note_text'],
      external_fields: ['command_text', 'titles', 'approved_note_text'] });
    await setBudget(f.env, { daily_call_limit: 10 });
    await f.ingest([command('shape-1', 'npm test -- login', 1, { session: 'shape-s', timestamp: '2026-10-07T08:00:01Z' }),
      command('shape-2', `deploy --token=${reviewToken} && echo ${key}`, 0, { session: 'shape-s', timestamp: '2026-10-07T08:00:02Z' }),
      syntheticEvent('shape-3', { action: 'file.modified', session: 'shape-s', timestamp: '2026-10-07T08:00:03Z',
        extra: { file: { path: '/Users/synthalice/private/plan-secret.md' } } }),
      command('shape-4', 'cat notes.txt', 0, { session: 'shape-s', timestamp: '2026-10-07T08:00:04Z',
        extra: { command: { command: 'cat notes.txt', exit_code: 0, output: 'OUTPUT_ONLY_MARKER' } } })]);
    await f.ingest(syntheticEvent('other-project', { repo: 'beta', session: 'beta-s' }));
    const first = await approvedNote(f, 'shape-1', '登入流程', '登入使用 cookie session；api_key=SYNTHETICNOTESECRET123 不可外流。');
    const second = await approvedNote(f, 'shape-1', 'Lint 規則', 'CI 必須跑 npm run lint。');
    const pending = await insertCandidate(f.env, { kind: 'memory', project_id: (await f.event('shape-1'))!.project_id, title: 'PENDING_NOTE_MARKER',
      content: 'Pending synthetic note.', sources: [{ event_id: (await f.event('shape-1'))!.id, payload_hash: (await f.event('shape-1'))!.payload_hash }] }, reviewer);
    const foreign = await approvedNote(f, 'other-project', 'FOREIGN_NOTE_MARKER', 'Another project note.');
    const project = (await f.event('shape-1'))!.project_id;
    const planned = (await run(f.env, { project_id: project })).scopes[0];
    const jev = fakeJev((body) => Response.json({ model: 'EVENT_CONTENT_MARKER', reason: 'PROVIDER_BODY_MARKER', answers: {
      new_information: { type: 'noul', noul: 0.7, confidence: 0.9 }, [`contradiction:${first}`]: { noul: 0.85, confidence: 0.6 },
      [`contradiction:${second}`]: { probability: 0.1 } }, usage: { input_tokens: 900, output_tokens: 12, cost_usd: 0.0004 } }));
    const now = noon();
    const report = await tick(gated(f.env), now, { fetcher: jev.fetcher });
    assert.deepEqual([report.ok, report.usage.fetch, jev.calls.length], [true, 1, 1]);
    const [sent] = jev.calls;
    assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(sent.init.method, 'POST');
    assert.equal(sent.init.redirect, 'manual');
    const headers = new Headers(sent.init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer ' + key);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(sent.body.model, 'jev-latest');
    assert.deepEqual(Object.keys(sent.body.questions), ['new_information', `contradiction:${second}`, `contradiction:${first}`]);
    assert.deepEqual(sent.body.state.approved_notes.map((note: any) => note.id), [second, first]);
    const stored = await f.env.DB.prepare('SELECT content FROM context_entries WHERE id=?').bind(first).first<{ content: string }>();
    assert.equal(sent.body.state.approved_notes[1].content_sha256, sha(stored!.content));
    assert.match(sent.body.state.approved_notes[1].content, /api_key=\[REDACTED\]/);
    assert.equal(sent.body.state.scope.type, 'project');
    assert.equal(sent.body.state.event_count, 4);
    const events = sent.body.state.events;
    assert.ok(events.every((event: any) => !('file_path' in event) && !('command_output' in event)));
    assert.equal(events.find((event: any) => event.action === 'file.modified').file_ext, '.md');
    assert.match(events[1].command_text, /deploy --token=\[REDACTED\]/);
    assert.deepEqual(hasAny(sent.text, [key, reviewToken, 'synthalice', 'plan-secret', 'OUTPUT_ONLY_MARKER', 'SYNTHETICNOTESECRET123',
      pending, foreign, 'PENDING_NOTE_MARKER', 'FOREIGN_NOTE_MARKER']), []);

    const done = await job(f.env, planned.job_id);
    assert.deepEqual([done.status, done.note], ['succeeded', null]);
    const call = (await f.env.DB.prepare('SELECT * FROM processing_calls WHERE job_id=?').bind(done.id).first<any>())!;
    assert.deepEqual([call.status, call.provider, call.model, call.attempt, call.input_chars, call.input_tokens, call.output_tokens,
      call.reported_cost_usd, call.error_code, call.day], ['succeeded', 'jev', 'jev-latest', 1, sent.text.length, 900, 12, 0.0004, null,
      now.toISOString().slice(0, 10)]);
    const signals = (await f.env.DB.prepare('SELECT * FROM processing_signals WHERE job_id=? ORDER BY question_id').bind(done.id).all<any>()).results;
    assert.deepEqual(signals.map((row) => [row.question_id, row.probability, row.confidence, row.calibrated, row.evaluator, row.model]), [
      [`contradiction:${first}`, 0.85, 0.6, 0, 'jev:api.typesafe.ai', 'jev-latest'], [`contradiction:${second}`, 0.1, null, 0, 'jev:api.typesafe.ai', 'jev-latest'],
      ['new_information', 0.7, 0.9, 0, 'jev:api.typesafe.ai', 'jev-latest']].sort());
    // The read API labels every probability as uncalibrated and names the note a contradiction is about.
    const detail = (await read(f.env, '/api/processing/jobs/' + done.id)).job;
    assert.ok(detail.signals.every((signal: any) => signal.label === 'uncalibrated' && signal.calibrated === false));
    assert.equal(detail.signals.find((signal: any) => signal.question_id === `contradiction:${first}`).context_id, first);
    assert.equal(detail.calls[0].status, 'succeeded');
    const usage = await read(f.env, '/api/processing/usage?day=' + now.toISOString().slice(0, 10));
    assert.deepEqual([usage.usage.calls, usage.usage.counted_tokens, usage.usage.reported_cost_usd, usage.remaining.calls], [1, 912, 0.0004, 9]);
    const operational = [detail, await read(f.env, '/api/processing/jobs'), usage, report, await jobs(f.env), signals, call];
    assert.deepEqual(hasAny(operational, ['EVENT_CONTENT_MARKER', 'PROVIDER_BODY_MARKER', key, reviewToken, 'npm test', 'synthalice']), []);
    // Jev is advisory: approved notes are untouched and the generated candidate is still pending.
    const statuses = (await f.env.DB.prepare('SELECT id,status FROM context_entries').all<any>()).results;
    assert.deepEqual(Object.fromEntries(statuses.filter((row) => [first, second].includes(row.id)).map((row) => [row.id, row.status])),
      { [first]: 'approved', [second]: 'approved' });
    assert.equal(statuses.find((row) => row.id === done.result_context_id).status, 'pending');
  } finally { await f.close(); }
});

test('a value assigned to a secret key in any part of the request is removed from every other part, before any cut', async () => {
  const f = await createEnvFixture();
  try {
    const fields = ['command_text', 'titles', 'approved_note_text'];
    // Command output is summarized locally but never sent; a value assigned there is still removed from what is sent.
    await setPolicy(f.env, workspace, { ...external, summary_fields: [...fields, 'command_output'], external_fields: fields });
    await setBudget(f.env, { daily_call_limit: 10 });
    const fromNote = 'NOTEASSIGNED98765', fromEvent = 'EVENTASSIGNED54321', fromTitle = 'TITLEASSIGNED77777', fromOutput = 'OUTPUTASSIGNED4242';
    await f.ingest([command('cross-1', `echo ${fromNote} ${fromTitle} ${fromOutput}`, 0, { session: 'cross-s', timestamp: '2026-10-07T08:00:01Z' }),
      command('cross-2', '', 0, { session: 'cross-s', timestamp: '2026-10-07T08:00:02Z',
        extra: { command: { command: `export API_KEY=${fromEvent}`, exit_code: 0, output: `token=${fromOutput}` } } }),
      // The note's value sits across this command's 1,200-character cut: only redacting first leaves no prefix.
      command('cross-3', 'x'.repeat(1180) + ' ' + fromNote + ' ' + 'y'.repeat(100), 0, { session: 'cross-s', timestamp: '2026-10-07T08:00:03Z' })]);
    const event = (await f.event('cross-1'))!;
    // Event → title and note; title → event; note → event.
    const taskId = await newTask(f.env, `合成 ${fromEvent} token=${fromTitle}`, [event.session_id]);
    const note = await approvedNote(f, 'cross-1', `筆記 ${fromEvent}`, `部署用 api_key=${fromNote} 已設定；舊值 ${fromEvent} 已停用。`, taskId);
    const planned = (await run(f.env, { task_id: taskId })).scopes[0];
    const jev = fakeJev();
    assert.equal((await tick(gated(f.env), noon(), { fetcher: jev.fetcher })).ok, true);
    assert.equal(jev.calls.length, 1);
    const [sent] = jev.calls;
    assert.deepEqual(hasAny(sent.text, [fromNote, fromEvent, fromTitle, fromOutput, fromNote.slice(0, 5)]), []);
    assert.ok(sent.body.state.events.every((item: any) => !('command_output' in item)));
    // Everything else is still there, and the notes keep their identity.
    assert.deepEqual(sent.body.state.events.map((item: any) => item.command_text.slice(0, 18)),
      ['echo [REDACTED] [R', 'export API_KEY=[RE', 'x'.repeat(18)]);
    assert.match(sent.body.state.events[2].command_text, /^x{1180} \[REDA\.\.\.\[truncated\]$/);
    assert.equal(sent.body.state.scope.task_title, '合成 [REDACTED] token=[REDACTED]');
    assert.deepEqual(sent.body.state.approved_notes.map((item: any) => [item.id, item.title, item.content]),
      [[note, '筆記 [REDACTED]', '部署用 api_key=[REDACTED] 已設定；舊值 [REDACTED] 已停用。']]);
    assert.equal((await job(f.env, planned.job_id)).status, 'succeeded');
  } finally { await f.close(); }
});

test('a Jev skip needs the policy threshold and is overridden by failures or a contradiction', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, { ...external, summary_fields: ['command_text', 'approved_note_text'],
      external_fields: ['command_text', 'approved_note_text'], jev_skip_threshold: 0.3 });
    await setBudget(f.env, { daily_call_limit: 10 });
    // Each scope's answers depend on its command text, as a real evaluator's would on content.
    const jev = fakeJev((body) => {
      const contradicted = body.state.events.some((event: any) => event.command_text === 'echo contra');
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) =>
        [id, { noul: id.startsWith('contradiction:') && contradicted ? 0.9 : 0.1 }])) });
    });
    const cases = [['quiet', 0], ['loud', 2], ['contra', 0]] as const;
    const planned: Record<string, string> = {};
    for (const [name, exit] of cases) {
      await f.ingest([command(`${name}-1`, name === 'contra' ? 'echo contra' : 'echo ' + name, exit, { repo: name, session: `${name}-s` }),
        syntheticEvent(`${name}-2`, { action: 'file.modified', repo: name, session: `${name}-s`, extra: { file: { path: '/synthetic/x.ts' } } })]);
      await approvedNote(f, `${name}-1`, `${name} note`, `Synthetic note for ${name}.`);
      planned[name] = (await run(f.env, { project_id: (await f.event(`${name}-1`))!.project_id })).scopes[0].job_id;
    }
    const start = noon();
    const report = await tick(gated(f.env), start, { fetcher: jev.fetcher });
    await tick(gated(f.env), new Date(start.getTime() + 60_000), { fetcher: jev.fetcher });
    assert.equal(report.ok, true);
    assert.equal(jev.calls.length, 3);
    const quiet = await job(f.env, planned.quiet);
    assert.deepEqual([quiet.status, quiet.skip_reason, quiet.result_context_id], ['skipped', 'jev_no_new_information', null]);
    // A Jev skip still covers its sources (the operator chose the threshold) and keeps its answers.
    assert.equal(await count(f.env, 'processing_coverage WHERE job_id=?', quiet.id), 2);
    assert.equal(await count(f.env, 'processing_signals WHERE job_id=?', quiet.id), 2);
    for (const name of ['loud', 'contra']) {
      const row = await job(f.env, planned[name]);
      assert.deepEqual([row.status, row.note], ['succeeded', 'jev_skip_overridden'], name);
    }
    // Without a threshold, the same low answer never skips.
    await setPolicy(f.env, workspace, { ...external, summary_fields: ['command_text', 'approved_note_text'],
      external_fields: ['command_text', 'approved_note_text'], jev_skip_threshold: null });
    await f.ingest(command('quiet-3', 'echo quiet', 0, { repo: 'quiet', session: 'quiet-s' }));
    const again = (await run(f.env, { project_id: quiet.project_id })).scopes[0];
    await tick(gated(f.env), new Date(start.getTime() + 120_000), { fetcher: jev.fetcher });
    assert.deepEqual([(await job(f.env, again.job_id)).status, (await job(f.env, again.job_id)).note], ['succeeded', null]);
  } finally { await f.close(); }
});

test('a retry after a successful call decides from the stored answers: a skip stays a skip, an override stays an override', async () => {
  const f = await createEnvFixture();
  try {
    const fields = ['command_text', 'approved_note_text'];
    await setPolicy(f.env, workspace, { ...external, summary_fields: fields, external_fields: fields, jev_skip_threshold: 0.3 });
    await setBudget(f.env, { daily_call_limit: 10 });
    // Both answer new_information below the threshold; only 'contra' contradicts its note.
    const jev = fakeJev((body) => {
      const contradicted = body.state.events.some((event: any) => event.command_text === 'echo contra');
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) =>
        [id, { noul: id.startsWith('contradiction:') && contradicted ? 0.9 : 0.1 }])) });
    });
    const planned: Record<string, string> = {};
    for (const name of ['quiet', 'contra']) {
      await f.ingest(command(`${name}-1`, 'echo ' + name, 0, { repo: name, session: `${name}-s` }));
      await approvedNote(f, `${name}-1`, `${name} note`, `Synthetic note for ${name}.`);
      planned[name] = (await run(f.env, { project_id: (await f.event(`${name}-1`))!.project_id })).scopes[0].job_id;
    }
    // Each job's attempt fails once after its Jev call committed: 'quiet' just after the
    // stage decided to skip, 'contra' in the generator.
    let skipFailures = 0, generated = 0;
    const stage: SelectionStage = async (input) => {
      const decision = await defaultStage(input);
      if (decision.decision === 'skip' && skipFailures++ === 0) throw new Error('synthetic failure after the Jev call');
      return decision;
    };
    const generator: Generator = { ...extractiveGenerator, async generate(input) {
      if (generated++ === 0) throw new Error('synthetic generator failure');
      return extractiveGenerator.generate(input);
    } };
    const tasks = [{ ...processingMaintenance[0], run: (env: Env, ctx: any) => processingTick(env, ctx, { stage, generator }) }];
    const start = noon();
    const first = await runMaintenance({ ...gated(f.env), MAINTENANCE_TASKS: 'processing' } as Env, { now: start, tasks, fetcher: jev.fetcher });
    assert.deepEqual(first.processing.result!.run_outcomes, { retry: 2 });
    assert.equal(jev.calls.length, 2);
    // One minute later each retry reads its stored answers instead of asking again.
    const retried = await runMaintenance({ ...gated(f.env), MAINTENANCE_TASKS: 'processing' } as Env,
      { now: new Date(start.getTime() + 60_000), tasks, fetcher: jev.fetcher });
    assert.deepEqual(retried.processing.result!.run_outcomes, { skipped: 1, succeeded: 1 });
    assert.deepEqual([jev.calls.length, retried.processing.usage.fetch], [2, 0]);
    const quiet = await job(f.env, planned.quiet), contra = await job(f.env, planned.contra);
    assert.deepEqual([quiet.status, quiet.attempts, quiet.skip_reason, quiet.result_context_id], ['skipped', 2, 'jev_no_new_information', null]);
    assert.deepEqual([contra.status, contra.attempts, contra.note], ['succeeded', 2, 'jev_skip_overridden']);
    for (const id of [quiet.id, contra.id]) assert.equal(await count(f.env, 'processing_calls WHERE job_id=?', id), 1);
  } finally { await f.close(); }
});

test('failures stay advisory: a 307 is not followed, a timeout is outcome_unknown and counted, and a job never re-sends', async (t) => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, external);
    await setBudget(f.env, { daily_call_limit: 3, timeout_ms: 1000 });
    const plan = async (name: string) => {
      await f.ingest(command(`${name}-1`, 'npm test', 0, { repo: name, session: `${name}-s` }));
      const taskId = await newTask(f.env, `合成任務 ${name}`, [(await f.event(`${name}-1`))!.session_id]);
      return (await run(f.env, { task_id: taskId })).scopes[0].job_id as string;
    };
    let now = noon();
    const later = () => (now = new Date(now.getTime() + 60_000));
    const redirected = await plan('redirect');
    const redirect = fakeJev(() => new Response('PROVIDER_BODY_MARKER', { status: 307, headers: { Location: 'https://elsewhere.invalid/' } }));
    await tick(gated(f.env), later(), { fetcher: redirect.fetcher });
    assert.deepEqual(redirect.calls.map((seen) => seen.url), ['https://api.typesafe.ai/v1/systemone']);
    const redirectedRow = await job(f.env, redirected);
    assert.deepEqual([redirectedRow.status, redirectedRow.note], ['succeeded', 'jev_failed']);
    const redirectCall = (await f.env.DB.prepare('SELECT status,error_code FROM processing_calls WHERE job_id=?').bind(redirected).first<any>())!;
    assert.deepEqual(redirectCall, { status: 'failed', error_code: 'redirect_rejected' });

    // The provider never answers: the call times out, and its job fails once for an unrelated reason.
    const timed = await plan('timeout');
    const hang = fakeJev((_, seen) => new Promise<Response>((_, reject) => seen.init.signal!.addEventListener('abort', () => reject(seen.init.signal!.reason))));
    let generated = 0;
    const flaky: Generator = { ...extractiveGenerator, async generate(input) {
      if (generated++ === 0) throw new Error('synthetic generator failure');
      return extractiveGenerator.generate(input);
    } };
    const tasks = [{ ...processingMaintenance[0], run: (env: Env, ctx: any) => processingTick(env, ctx, { generator: flaky }) }];
    const alive = setInterval(() => {}, 1000);
    t.after(() => clearInterval(alive));
    const started = Date.now();
    const first = await runMaintenance({ ...gated(f.env), MAINTENANCE_TASKS: 'processing' } as Env, { now: later(), tasks, fetcher: hang.fetcher });
    assert.ok(Date.now() - started < 10_000);
    assert.deepEqual(first.processing.result!.run_outcomes, { retry: 1 });
    const unknown = (await f.env.DB.prepare('SELECT status,error_code,estimated_tokens FROM processing_calls WHERE job_id=?').bind(timed).first<any>())!;
    assert.deepEqual([unknown.status, unknown.error_code], ['outcome_unknown', 'timeout']);
    assert.equal((await job(f.env, timed)).last_error, 'job_failed');
    now = new Date(now.getTime() + 5 * 60_000);
    const retried = await runMaintenance({ ...gated(f.env), MAINTENANCE_TASKS: 'processing' } as Env, { now: later(), tasks, fetcher: hang.fetcher });
    assert.deepEqual(retried.processing.result!.run_outcomes, { succeeded: 1 });
    // The retry did not send again, and says why.
    assert.equal(hang.calls.length, 1);
    const finished = await job(f.env, timed);
    assert.deepEqual([finished.status, finished.attempts, finished.note], ['succeeded', 2, 'jev_previous_outcome_unknown']);
    assert.equal(await count(f.env, 'processing_calls WHERE job_id=?', timed), 1);

    // The unknown outcome still counts: with a limit of three, a third job of the day gets the last call.
    const third = await plan('third');
    const answered = fakeJev();
    await tick(gated(f.env), later(), { fetcher: answered.fetcher });
    assert.equal(answered.calls.length, 1);
    const fourth = await plan('fourth');
    await tick(gated(f.env), later(), { fetcher: answered.fetcher });
    assert.equal(answered.calls.length, 1);
    assert.equal((await job(f.env, fourth)).note, 'jev_budget:daily_call_limit');
    const usage = await read(f.env, '/api/processing/usage?day=' + now.toISOString().slice(0, 10));
    assert.deepEqual([usage.usage.calls, usage.usage.failed, usage.usage.outcome_unknown, usage.usage.succeeded, usage.remaining.calls], [3, 1, 1, 1, 0]);
    assert.equal((await job(f.env, third)).note, null);

    // A crash after reserving leaves a reserved row; the sweep marks it, and the reclaimed job does not re-send.
    await setBudget(f.env, { daily_call_limit: 10, timeout_ms: 1000 });
    const crashed = await plan('crash');
    const crashAt = later();
    await f.env.DB.prepare(`UPDATE processing_jobs SET status='running',attempts=1,lease_owner='crashed',lease_until=? WHERE id=?`)
      .bind(new Date(crashAt.getTime() + 60_000).toISOString(), crashed).run();
    await f.env.DB.prepare(`INSERT INTO processing_calls(id,job_id,provider,model,attempt,status,day,input_chars,estimated_tokens,started_at)
      VALUES(?,?,'jev','jev-latest',1,'reserved',?,100,290,?)`).bind(crypto.randomUUID(), crashed, crashAt.toISOString().slice(0, 10), crashAt.toISOString()).run();
    const swept = await tick(gated(f.env), new Date(crashAt.getTime() + 5 * 60_000), { fetcher: answered.fetcher });
    assert.equal(swept.result!.stale_reservations, 1);
    assert.equal(answered.calls.length, 1);
    const recovered = await job(f.env, crashed);
    assert.deepEqual([recovered.status, recovered.attempts, recovered.note], ['succeeded', 2, 'jev_previous_outcome_unknown']);
    assert.equal((await f.env.DB.prepare('SELECT status FROM processing_calls WHERE job_id=?').bind(crashed).first<any>())!.status, 'outcome_unknown');
  } finally { await f.close(); }
});

test('two overlapping invocations with a daily limit of one send exactly one request', async () => {
  const f = await createEnvFixture();
  try {
    await setPolicy(f.env, workspace, external);
    await setBudget(f.env, { daily_call_limit: 1 });
    const planned: string[] = [];
    for (const name of ['race-a', 'race-b', 'race-c', 'race-d']) {
      await f.ingest(command(`${name}-1`, 'npm test', 0, { repo: name, session: `${name}-s` }));
      const taskId = await newTask(f.env, `合成任務 ${name}`, [(await f.event(`${name}-1`))!.session_id]);
      planned.push((await run(f.env, { task_id: taskId })).scopes[0].job_id);
    }
    const jev = fakeJev(async (body) => { await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({ answers: { task_related: { noul: 0.9 } } }); });
    const now = noon();
    const reports = await Promise.all([tick(gated(f.env), now, { fetcher: jev.fetcher }), tick(gated(f.env), now, { fetcher: jev.fetcher })]);
    assert.ok(reports.every((report) => report.ok), JSON.stringify(reports));
    assert.equal(jev.calls.length, 1);
    assert.equal(reports[0].usage.fetch + reports[1].usage.fetch, 1);
    assert.equal(await count(f.env, 'processing_calls'), 1);
    const rows = await Promise.all(planned.map((id) => job(f.env, id)));
    assert.equal(rows.filter((row) => row.status === 'succeeded').length, 4);
    assert.equal(rows.filter((row) => row.note === 'jev_budget:daily_call_limit').length, 3);
  } finally { await f.close(); }
});

test('scheduled logs, reports, job errors and read APIs never carry event content, the key or a provider body', async (t) => {
  const f = await createEnvFixture({ bindings: { REVIEW_TOKEN: reviewToken } });
  const logged: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, fetch: globalThis.fetch };
  try {
    await setPolicy(f.env, workspace, { ...external, summary_fields: ['command_text', 'titles'], external_fields: ['command_text', 'titles'] });
    await setBudget(f.env, { daily_call_limit: 10 });
    for (const name of ['echo', 'model']) {
      await f.ingest(command(`${name}-1`, `echo EVENT_CONTENT_MARKER ${name} token=${key}`, 1, { repo: name, session: `${name}-s` }));
      const taskId = await newTask(f.env, `TITLE_MARKER ${name}`, [(await f.event(`${name}-1`))!.session_id]);
      await run(f.env, { task_id: taskId });
    }
    // One provider error echoes the request and leaks detail; one success smuggles text into every field.
    const jev = fakeJev((body, seen) => body.state.scope.task_title.endsWith('echo')
      ? new Response('PROVIDER_BODY_MARKER ' + seen.text, { status: 500 })
      : Response.json({ model: 'EVENT_CONTENT_MARKER', reason: 'PROVIDER_BODY_MARKER', answers: { task_related: { noul: 0.8, reason: 'PROVIDER_BODY_MARKER' } },
        usage: { input_tokens: 10, output_tokens: 2, note: 'PROVIDER_BODY_MARKER' } }));
    for (const name of ['log', 'error', 'warn'] as const) console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    globalThis.fetch = jev.fetcher;
    const now = noon();
    await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: now.getTime(), noRetry() {} } as ScheduledController,
      { ...gated(f.env), MAINTENANCE_TASKS: 'processing' } as Env);
    Object.assign(console, { log: original.log, error: original.error, warn: original.warn });
    globalThis.fetch = original.fetch;
    assert.equal(jev.calls.length, 2);
    assert.ok(jev.calls.every((seen) => seen.text.includes('EVENT_CONTENT_MARKER') && !seen.text.includes(key)));
    assert.equal(logged.length, 1);
    assert.deepEqual(JSON.parse(logged[0]).maintenance.processing.ok, true);
    const rows = await jobs(f.env);
    assert.deepEqual(rows.map((row) => row.note ?? 'none').sort(), ['jev_failed', 'none']);
    const ledger = (await f.env.DB.prepare('SELECT * FROM processing_calls ORDER BY error_code').all<any>()).results;
    assert.deepEqual(ledger.map((row) => [row.status, row.error_code]), [['succeeded', null], ['failed', 'http_500']]);
    const signals = (await f.env.DB.prepare('SELECT * FROM processing_signals').all<any>()).results;
    const reads = [await read(f.env, '/api/processing/jobs')];
    for (const row of rows) reads.push(await read(f.env, '/api/processing/jobs/' + row.id));
    reads.push(await read(f.env, '/api/processing/usage?day=' + now.toISOString().slice(0, 10)));
    assert.deepEqual(hasAny([logged, rows, ledger, signals, reads], ['EVENT_CONTENT_MARKER', 'PROVIDER_BODY_MARKER', 'TITLE_MARKER', key, reviewToken]), []);
  } finally {
    Object.assign(console, { log: original.log, error: original.error, warn: original.warn });
    globalThis.fetch = original.fetch;
    await f.close();
  }
});
