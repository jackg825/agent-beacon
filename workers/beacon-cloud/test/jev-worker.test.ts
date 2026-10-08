import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyMigrations } from './migrations';
import { workflowEvent, workflowTokens as tokens } from './workflow-fixture';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const key = 'synthetic-worker-jev-key-00000000000';
type Outbound = { url: string; method: string; authorization: string | null; body: string };

test('bundled Worker: Jev runs only through workerd fetch with redirects refused, timeouts enforced and signals readable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-jev-'));
  const outbound: Outbound[] = [];
  let mode: 'redirect' | 'answer' | 'hang' = 'redirect';
  // Every outbound fetch the Worker makes lands here; nothing reaches a network.
  const provider = async (request: Request) => {
    outbound.push({ url: request.url, method: request.method, authorization: request.headers.get('Authorization'), body: await request.text() });
    if (mode === 'redirect') return new Response('PROVIDER_BODY_MARKER', { status: 307, headers: { Location: 'https://elsewhere.invalid/collect' } });
    if (mode === 'hang') { await new Promise((done) => setTimeout(done, 2500)); return Response.json({ answers: { task_related: { noul: 1 } } }); }
    return Response.json({ model: 'PROVIDER_BODY_MARKER', answers: { task_related: { type: 'noul', noul: 0.83, confidence: 0.4 } },
      usage: { input_tokens: 220, output_tokens: 4, cost_usd: 0.0002 } });
  };
  const mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'storage'), workers: [{
    name: 'jev', modules: true as const, scriptPath: resolve('dist/worker.mjs'), compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'jev-index' }, r2Buckets: { RAW: 'jev-raw' }, outboundService: provider,
    bindings: { READ_TOKEN: tokens.read, REVIEW_TOKEN: tokens.review, MCP_TOKEN: tokens.mcp, MAINTENANCE_TASKS: 'processing',
      EXTERNAL_PROCESSING_PROJECTS: '*', JEV_API_KEY: key } }] }));
  const request = (path: string, init: Parameters<typeof mf.dispatchFetch>[1] = {}) => mf.dispatchFetch('http://localhost' + path, init);
  const get = async (path: string) => (await request(path, { headers: { Authorization: 'Bearer ' + tokens.read } })).json() as Promise<any>;
  const post = async (path: string, body: unknown, expected = 200) => {
    const response = await request(path, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.review, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    assert.equal(response.status, expected, path);
    return response.json() as Promise<any>;
  };
  const upload = (records: unknown[]) => request('/v1/ingest/runtime', { method: 'POST',
    headers: { Authorization: 'Bearer ' + tokens.mbp, 'Content-Type': 'application/x-ndjson' }, body: records.map((record) => JSON.stringify(record)).join('\n') + '\n' });
  const event = (id: string) => ({ ...workflowEvent(id, 'alpha', 'jev-session'), command: { command: 'echo EVENT_CONTENT_MARKER', exit_code: 0 } });
  try {
    const db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').bind('mbp', 'Synthetic MBP', hash(tokens.mbp), '2026-10-08T00:00:00Z').run();
    assert.equal((await upload([event('jev-1'), event('jev-2')])).status, 200);
    const session = (await get('/api/sessions?limit=5')).sessions[0].id as string;
    const taskId = (await post('/api/tasks', { title: '合成：外部篩選' }, 201)).task.id as string;
    await post(`/api/tasks/${taskId}/sessions`, { session_id: session }, 201);
    await post('/api/processing/policies', { scope_type: 'workspace', scope_id: '*', enabled: true, external_allowed: true, jev_enabled: true,
      summary_fields: ['command_text', 'titles'], external_fields: ['titles'], min_new_events: 1000, quiet_minutes: 0, max_events_per_job: 200,
      jev_skip_threshold: null });
    await post('/api/processing/budget', { daily_call_limit: 5, daily_token_limit: 50_000, daily_usd_ceiling: 1, max_input_chars: 8000,
      max_output_tokens: 128, timeout_ms: 1000 });
    const worker = await mf.getWorker();
    // A fixed future UTC noon: the three calls (at, +1 and +2 minutes) always share one ledger day.
    const at = new Date(Math.ceil((Date.now() + 3 * 3_600_000) / 86_400_000) * 86_400_000 + 12 * 3_600_000);
    const day = at.toISOString().slice(0, 10);
    const runOnce = async (minutes: number) => {
      const planned = (await post('/api/processing/run', { task_id: taskId })).scopes[0];
      assert.equal(planned.status, 'planned');
      assert.equal((await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: new Date(at.getTime() + minutes * 60_000) })).outcome, 'ok');
      return (await get('/api/processing/jobs/' + planned.job_id)).job;
    };

    // 1. The provider answers 307: workerd returns it unfollowed and the job continues without signals.
    const redirected = await runOnce(0);
    assert.deepEqual(outbound.map((item) => [item.method, item.url]), [['POST', 'https://api.typesafe.ai/v1/systemone']]);
    assert.equal(outbound[0].authorization, 'Bearer ' + key);
    const sent = JSON.parse(outbound[0].body);
    assert.deepEqual(Object.keys(sent.questions), ['task_related']);
    assert.equal(sent.state.scope.task_title, '合成：外部篩選');
    assert.ok(!outbound[0].body.includes('EVENT_CONTENT_MARKER'), 'command text is not an external field here');
    assert.deepEqual([redirected.status, redirected.note, redirected.signals], ['succeeded', 'jev_failed', []]);
    assert.deepEqual(redirected.calls.map((call: any) => [call.status, call.error_code]), [['failed', 'redirect_rejected']]);
    await post(`/api/context/${redirected.result_context_id}/review`, { decision: 'reject' });

    // 2. The provider never answers within the budget's 1 s: workerd aborts, the outcome is unknown and counted.
    mode = 'hang';
    assert.equal((await upload([event('jev-3')])).status, 200);
    const started = Date.now();
    const timed = await runOnce(1);
    assert.ok(Date.now() - started < 2400, 'the Worker gave up before the provider answered');
    assert.deepEqual([timed.status, timed.note], ['succeeded', 'jev_outcome_unknown']);
    assert.deepEqual(timed.calls.map((call: any) => [call.status, call.error_code]), [['outcome_unknown', 'timeout']]);
    await post(`/api/context/${timed.result_context_id}/review`, { decision: 'reject' });

    // 3. A normal answer becomes an uncalibrated signal, readable over HTTP and MCP.
    mode = 'answer';
    assert.equal((await upload([event('jev-4')])).status, 200);
    const answered = await runOnce(2);
    assert.equal(outbound.length, 3);
    assert.deepEqual(answered.signals.map((signal: any) => [signal.question_id, signal.probability, signal.confidence, signal.label, signal.model]),
      [['task_related', 0.83, 0.4, 'uncalibrated', 'jev-latest']]);
    assert.deepEqual(answered.calls.map((call: any) => [call.status, call.input_tokens, call.output_tokens, call.reported_cost_usd]),
      [['succeeded', 220, 4, 0.0002]]);
    const usage = await get('/api/processing/usage?day=' + day);
    assert.deepEqual([usage.usage.calls, usage.usage.failed, usage.usage.outcome_unknown, usage.usage.succeeded, usage.remaining.calls], [3, 1, 1, 1, 2]);
    const client = new Client({ name: 'synthetic-jev-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + tokens.mcp } }, fetch: mf.dispatchFetch.bind(mf) as unknown as typeof fetch });
    try {
      await client.connect(transport);
      const detail = await client.callTool({ name: 'beacon_get_processing_job', arguments: { job_id: answered.id } });
      const job = (detail.structuredContent as any).job;
      assert.deepEqual(job.signals.map((signal: any) => [signal.question_id, signal.probability, signal.label]), [['task_related', 0.83, 'uncalibrated']]);
      assert.equal(job.calls[0].provider, 'jev');
    } finally { await client.close(); }
    const reads = [usage, redirected, timed, answered, await get('/api/processing/jobs')];
    for (const needle of ['PROVIDER_BODY_MARKER', 'EVENT_CONTENT_MARKER', key]) assert.ok(!JSON.stringify(reads).includes(needle), needle);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
    t.diagnostic(`outbound requests: ${outbound.length}`);
  }
});
