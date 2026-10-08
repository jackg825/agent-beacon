import test from 'node:test';
import assert from 'node:assert/strict';
import { externalEndpoint, externalFetch } from '../src/external-fetch';
import { externalEvent, fitJevRequest, JEV_INSTRUCTIONS, jevDecision, jevQuestions, JevNote, parseJevResponse } from '../src/jev';
import { MaintenanceError } from '../src/maintenance';
import type { ProjectedEvent } from '../src/privacy';
import { DEFAULT_POLICY, PolicyValues } from '../src/processing-policy';

const limits = { timeoutMs: 2000, maxBytes: 64 };
type Seen = { url: string; init: RequestInit };
function fake(answer: (seen: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const seen = { url: String(input), init };
    calls.push(seen);
    return answer(seen);
  }) as typeof fetch;
  return { calls, fetcher };
}
/** A provider that never answers until the caller's own signal aborts the request. */
const hang = ({ init }: Seen) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
const stream = (chunks: string[], stallAfter = false) => new ReadableStream<Uint8Array>({
  async pull(controller) {
    const next = chunks.shift();
    if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
    else if (stallAfter) await new Promise(() => {});
    else controller.close();
  } });

test('externalFetch never follows a redirect: a 307 or opaque redirect is refused after one request', async () => {
  const redirect = fake(() => new Response('PROVIDER_BODY_MARKER', { status: 307, headers: { Location: 'https://elsewhere.invalid/next' } }));
  const result = await externalFetch(redirect.fetcher, 'https://jev.example.invalid/v1', { method: 'POST', body: '{}' }, limits);
  assert.deepEqual(result, { ok: false, outcome: 'failed', code: 'redirect_rejected', status: 307 });
  assert.equal(redirect.calls.length, 1);
  assert.equal(redirect.calls[0].url, 'https://jev.example.invalid/v1');
  assert.equal(redirect.calls[0].init.redirect, 'manual');
  assert.ok(redirect.calls[0].init.signal instanceof AbortSignal);
  for (const status of [301, 302, 303, 308]) {
    const other = fake(() => new Response(null, { status, headers: { Location: 'https://elsewhere.invalid/' } }));
    assert.equal(((await externalFetch(other.fetcher, 'https://jev.example.invalid/v1', {}, limits)) as any).code, 'redirect_rejected');
    assert.equal(other.calls.length, 1);
  }
  // Runtimes other than workerd can surface manual redirects as an opaque response.
  const opaque = fake(() => ({ type: 'opaqueredirect', status: 0, headers: new Headers(), body: null }) as unknown as Response);
  assert.equal(((await externalFetch(opaque.fetcher, 'https://jev.example.invalid/v1', {}, limits)) as any).code, 'redirect_rejected');
  // Whatever the caller asks for, the helper always sends redirect:'manual'.
  const forced = fake(() => new Response('{}'));
  await externalFetch(forced.fetcher, 'https://jev.example.invalid/v1', { redirect: 'follow' }, limits);
  assert.equal(forced.calls[0].init.redirect, 'manual');
});

test('externalFetch reports codes only: HTTP errors, timeouts, network errors, size caps and bad encodings', async (t) => {
  // Node unrefs AbortSignal.timeout timers; keep the loop alive while a fake provider hangs.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  const url = 'https://jev.example.invalid/v1';
  const results: unknown[] = [];
  const check = async (answer: (seen: Seen) => Response | Promise<Response>, expected: Record<string, unknown>, options = limits) => {
    const result = await externalFetch(fake(answer).fetcher, url, { method: 'POST', body: 'EVENT_CONTENT_MARKER' }, options);
    results.push(result);
    for (const [key, value] of Object.entries(expected)) assert.equal((result as any)[key], value, JSON.stringify([expected, result]));
  };
  await check(() => new Response('PROVIDER_BODY_MARKER internal detail', { status: 500 }), { ok: false, outcome: 'failed', code: 'http_500' });
  await check(() => new Response('PROVIDER_BODY_MARKER', { status: 429 }), { code: 'http_429' });
  const started = Date.now();
  await check(hang, { outcome: 'outcome_unknown', code: 'timeout' }, { timeoutMs: 50, maxBytes: 64 });
  assert.ok(Date.now() - started < 1500);
  await check(() => { throw new TypeError('connect ECONNREFUSED PROVIDER_BODY_MARKER'); }, { outcome: 'outcome_unknown', code: 'network_error' });
  // The metered ctx.fetch refuses before sending: a definite, unsent failure.
  await check(() => { throw new MaintenanceError('budget_exhausted:fetch'); }, { outcome: 'failed', code: 'budget_exhausted:fetch' });
  await check(() => new Response(stream(['x'.repeat(40), 'y'.repeat(40)])), { outcome: 'failed', code: 'response_too_large' });
  await check(() => new Response('{}', { headers: { 'Content-Length': '999999' } }), { code: 'response_too_large' });
  // The body stalls after the provider answered: it may have acted, so the outcome is unknown.
  await check(() => new Response(stream(['{"answers":'], true)), { outcome: 'outcome_unknown', code: 'timeout' }, { timeoutMs: 80, maxBytes: 64 });
  await check(() => new Response(new Uint8Array([0xff, 0xfe, 0x00])), { outcome: 'failed', code: 'invalid_response' });
  await check(() => new Response('{"ok":true}', { status: 200 }), { ok: true, text: '{"ok":true}' });
  assert.ok(!JSON.stringify(results).includes('PROVIDER_BODY_MARKER'));
  assert.ok(!JSON.stringify(results).includes('EVENT_CONTENT_MARKER'));
});

test('provider endpoints must be https with a host and no userinfo, query, fragment or loop back to this Worker', () => {
  const fallback = 'https://api.typesafe.ai/v1/systemone';
  assert.equal(externalEndpoint(undefined, fallback), fallback);
  assert.equal(externalEndpoint('  ', fallback), fallback);
  assert.equal(externalEndpoint('https://jev.example.invalid/v1/systemone', fallback, 'https://beacon.example.invalid'),
    'https://jev.example.invalid/v1/systemone');
  for (const bad of ['http://jev.example.invalid/v1', 'https://user:pass@jev.example.invalid/v1', 'https://token@jev.example.invalid/',
    'https://jev.example.invalid/v1?key=x', 'https://jev.example.invalid/v1#x', 'ftp://jev.example.invalid/', 'https:///nohost',
    'not a url', 'https://jev.example.invalid/' + 'a'.repeat(600), 'https://BEACON.example.invalid:8443/v1'])
    assert.equal(externalEndpoint(bad, fallback, 'https://beacon.example.invalid'), null, bad);
  assert.equal(externalEndpoint(undefined, fallback, 'not a url'), null);
});

test('the request follows the System One wire contract with only asked questions and policy-narrowed events', () => {
  const notes: JevNote[] = [{ id: '11111111-1111-4111-8111-111111111111', kind: 'memory', title: 'Login flow', content: 'Use cookie sessions.',
    content_sha256: 'a'.repeat(64) }];
  const questions = jevQuestions(notes, true);
  assert.deepEqual(Object.keys(questions), ['new_information', 'task_related', 'contradiction:11111111-1111-4111-8111-111111111111']);
  for (const value of Object.values(questions)) {
    assert.equal(value.type, 'noul');
    assert.deepEqual(Object.keys(value.criteria), ['true', 'false']);
  }
  assert.equal(questions.new_information.instructions, JEV_INSTRUCTIONS.new_information);
  assert.match(questions['contradiction:11111111-1111-4111-8111-111111111111'].instructions, /contradict the approved note 11111111-/);
  // Without notes only task_related remains; without either, nothing would be asked.
  assert.deepEqual(Object.keys(jevQuestions([], true)), ['task_related']);
  assert.deepEqual(jevQuestions([], false), {});
  const event: ProjectedEvent = { action: 'command.executed', kind: 'agent_runtime', timestamp: '2026-10-07T08:00:01.000Z', harness: 'codex_cli',
    exit_code: 1, approval_decision: 'denied', usage: { input_tokens: 5 }, file_path: 'src/auth/login.ts', command_text: 'npm test',
    command_output: 'EVENT_CONTENT_MARKER', tool_name: 'Bash' };
  assert.deepEqual(externalEvent(event, new Set(['command_text']), 3), { number: 3, action: 'command.executed', kind: 'agent_runtime',
    timestamp: '2026-10-07T08:00:01.000Z', harness: 'codex_cli', exit_code: 1, approval_decision: 'denied', usage: { input_tokens: 5 },
    file_ext: '.ts', command_text: 'npm test' });
  assert.equal(externalEvent(event, new Set(['file_path', 'tool_name']), 1).file_path, 'src/auth/login.ts');
  assert.equal(externalEvent({ ...event, file_path: undefined, file_ext: '.md' }, new Set(), 1).file_ext, '.md');
  const fit = fitJevRequest('jev-latest', { rubric_version: 'beacon.cloud.jev.v1', scope: { type: 'task' } },
    [externalEvent(event, new Set(['command_text']), 1)], notes, true, 20_000)!;
  assert.deepEqual(Object.keys(fit.request), ['model', 'state', 'questions']);
  assert.deepEqual(JSON.parse(fit.body), fit.request);
  assert.deepEqual(Object.keys(fit.request.state), ['rubric_version', 'scope', 'event_count', 'events', 'approved_notes']);
  assert.ok(!fit.body.includes('EVENT_CONTENT_MARKER'));
});

test('oversized requests are cut deterministically: head and tail events around a marker, then notes', () => {
  const events = Array.from({ length: 40 }, (_, index) => ({ number: index + 1, action: 'command.executed', command_text: 'step ' + index + ' ' + 'x'.repeat(80) }));
  const notes: JevNote[] = Array.from({ length: 3 }, (_, index) => ({ id: `0000000${index}-0000-4000-8000-000000000000`, kind: 'memory',
    content: 'n'.repeat(400), content_sha256: String(index).repeat(64) }));
  const base = { rubric_version: 'beacon.cloud.jev.v1', scope: { type: 'project' } };
  const full = fitJevRequest('jev-latest', base, events, notes, false, 200_000)!;
  assert.equal(full.kept_events, 40); assert.equal(full.kept_notes, 3);
  const limit = full.body.length - 2000;
  const cut = fitJevRequest('jev-latest', base, events, notes, false, limit)!;
  assert.ok(cut.body.length <= limit);
  assert.ok(cut.kept_events < 40 && cut.kept_events > 1);
  assert.equal(cut.kept_notes, 3);
  const listed = cut.request.state.events as any[];
  const marker = listed.findIndex((item) => 'omitted_events' in item);
  assert.equal(listed[marker].omitted_events, 40 - cut.kept_events);
  assert.deepEqual(listed.slice(0, marker).map((item) => item.number), Array.from({ length: Math.floor(cut.kept_events / 2) }, (_, i) => i + 1));
  assert.equal(listed.at(-1).number, 40);
  // The largest cut that fits is chosen, and the same input always gives the same bytes.
  assert.equal(fitJevRequest('jev-latest', base, events, notes, false, limit)!.body, cut.body);
  assert.equal(fitJevRequest('jev-latest', base, events, notes, false, cut.body.length - 1)!.kept_events, cut.kept_events - 1);
  const tighter = fitJevRequest('jev-latest', base, events, notes, false, 1600)!;
  assert.ok(tighter.body.length <= 1600);
  assert.ok(tighter.kept_notes < 3);
  assert.deepEqual(Object.keys(tighter.request.questions).filter((id) => id.startsWith('contradiction:')).length, tighter.kept_notes);
  // Nothing can fit, or nothing is left to ask: no request at all.
  assert.equal(fitJevRequest('jev-latest', base, events, notes, false, 200), null);
  assert.equal(fitJevRequest('jev-latest', base, events, [], false, 200_000), null);
  assert.equal(fitJevRequest('jev-latest', base, [], notes, false, 200_000), null);
});

test('answers are parsed like upstream: noul, probability or score, asked questions only, numbers only', () => {
  const asked = ['new_information', 'task_related', 'contradiction:11111111-1111-4111-8111-111111111111'];
  const parsed = parseJevResponse(JSON.stringify({ model: 'EVENT_CONTENT_MARKER', answers: {
    new_information: { type: 'noul', noul: 0.12, probability: 0.9, confidence: 0.7 },
    task_related: { probability: 1.4 }, 'contradiction:11111111-1111-4111-8111-111111111111': { score: -0.2, confidence: 'high' },
    unasked: { noul: 0.5 }, reason: 'PROVIDER_BODY_MARKER' },
    usage: { input_tokens: 120, output_tokens: 7, cost_usd: 0.0004, credits_remaining_usd: 9 } }), asked)!;
  assert.deepEqual([...parsed.answers], [['new_information', { probability: 0.12, confidence: 0.7 }], ['task_related', { probability: 1, confidence: null }],
    ['contradiction:11111111-1111-4111-8111-111111111111', { probability: 0, confidence: null }]]);
  assert.deepEqual(parsed.usage, { input_tokens: 120, output_tokens: 7, cost_usd: 0.0004 });
  assert.ok(!JSON.stringify([...parsed.answers]).includes('MARKER'));
  // The earlier questions/results shapes are accepted when answers is absent.
  assert.deepEqual([...parseJevResponse(JSON.stringify({ results: [{ id: 'task_related', probability: 0.4, confidence: 0.5 }] }), asked)!.answers],
    [['task_related', { probability: 0.4, confidence: 0.5 }]]);
  assert.equal(parseJevResponse(JSON.stringify({ questions: [{ id: 'unasked', probability: 0.4 }] }), asked)!.answers.size, 0);
  for (const bad of ['not json', '[]', 'null', '"text"']) assert.equal(parseJevResponse(bad, asked), null);
  assert.deepEqual(parseJevResponse(JSON.stringify({ answers: { task_related: { noul: 'NaN' } }, usage: { input_tokens: -1, output_tokens: 2.5,
    cost_usd: -3 } }), asked), { answers: new Map(), usage: { input_tokens: undefined, output_tokens: undefined, cost_usd: undefined } });
});

test('decisions: skip only under the threshold and never past high-signal events or contradictions', () => {
  const policy = (threshold: number | null) => ({ ...DEFAULT_POLICY, jev_skip_threshold: threshold } as PolicyValues);
  const quiet: ProjectedEvent[] = [{ action: 'file.modified', kind: 'agent_runtime', timestamp: 't', harness: 'h' }];
  const low = [{ question_id: 'new_information', probability: 0.1 }];
  assert.deepEqual(jevDecision({ policy: policy(null), projection: quiet }, low), { decision: 'continue', signals: [] });
  assert.deepEqual(jevDecision({ policy: policy(0.3), projection: quiet }, low), { decision: 'skip', skip_reason: 'jev_no_new_information', signals: [] });
  assert.equal(jevDecision({ policy: policy(0.1), projection: quiet }, low).decision, 'continue');
  assert.equal(jevDecision({ policy: policy(0.3), projection: quiet }, [{ question_id: 'task_related', probability: 0 }]).decision, 'continue');
  for (const highSignal of [{ exit_code: 2 }, { approval_decision: 'denied' }, { policy_enforcement: 'enforce' }, { action: 'tool.failed' }])
    assert.deepEqual(jevDecision({ policy: policy(0.3), projection: [{ ...quiet[0], ...highSignal }] }, low),
      { decision: 'continue', note: 'jev_skip_overridden', signals: [] }, JSON.stringify(highSignal));
  assert.equal(jevDecision({ policy: policy(0.3), projection: quiet },
    [...low, { question_id: 'contradiction:11111111-1111-4111-8111-111111111111', probability: 0.5 }]).note, 'jev_skip_overridden');
});
