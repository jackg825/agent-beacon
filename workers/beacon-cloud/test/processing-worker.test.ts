import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyMigrations } from './migrations';
import { openPolicy } from './processing-helpers';
import { workflowEvent, workflowTokens as tokens } from './workflow-fixture';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('bundled Worker: processing routes keep roles separate and a scheduled tick produces a pending candidate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-processing-'));
  const mf = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'storage'), workers: [{
    name: 'processing', modules: true as const, scriptPath: resolve('dist/worker.mjs'), compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'processing-index' }, r2Buckets: { RAW: 'processing-raw' },
    bindings: { READ_TOKEN: tokens.read, REVIEW_TOKEN: tokens.review, MCP_TOKEN: tokens.mcp, MAINTENANCE_TASKS: 'processing' } }] }));
  const request = (path: string, init: Parameters<typeof mf.dispatchFetch>[1] = {}) => mf.dispatchFetch('http://localhost' + path, init);
  const get = (path: string, token?: string) => request(path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const post = (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) => request(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: JSON.stringify(body) });
  const upload = (records: unknown[], token = tokens.mbp) => request('/v1/ingest/runtime', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-ndjson' }, body: records.map((record) => JSON.stringify(record)).join('\n') + '\n' });
  try {
    const db = await mf.getD1Database('DB');
    await applyMigrations(db);
    for (const [id, name, token] of [['mbp', 'Synthetic MBP', tokens.mbp], ['mini', 'Synthetic Mac mini', tokens.mini]])
      await db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').bind(id, name, hash(token), '2026-10-08T00:00:00Z').run();
    assert.equal((await upload([workflowEvent('worker-1'), { ...workflowEvent('worker-2'), event: { id: 'worker-2', action: 'command.executed',
      kind: 'agent_runtime' }, command: { command: 'npm test', exit_code: 0 } }])).status, 200);
    assert.equal((await upload([workflowEvent('worker-3', 'alpha', 'mini-session')], tokens.mini)).status, 200);
    const project = ((await (await get('/api/projects', tokens.read)).json()) as any).projects[0].id as string;
    const worker = await mf.getWorker();
    const frequent = (minutes: number) => worker.scheduled({ cron: '*/15 * * * *', scheduledTime: new Date(Date.now() + minutes * 60_000) });

    await t.test('every read route needs read authority; device, MCP and review credentials are refused', async () => {
      for (const path of ['/api/processing/policy', '/api/processing/policy?project_id=' + project, '/api/processing/jobs', '/api/processing/jobs/' + '0'.repeat(64)]) {
        for (const token of [undefined, tokens.mcp, tokens.mbp, tokens.review]) assert.equal((await get(path, token)).status, 401, `${path} ${token}`);
        assert.notEqual((await get(path, tokens.read)).status, 401);
      }
      assert.equal((await get('/api/processing/jobs/' + '0'.repeat(64), tokens.read)).status, 404);
      assert.equal((await get('/api/processing/jobs?status=bad', tokens.read)).status, 400);
    });

    await t.test('every write route needs the independent review credential and a same-origin request', async () => {
      const writes: [string, unknown][] = [['/api/processing/policies', { ...openPolicy, scope_type: 'workspace', scope_id: '*' }],
        ['/api/processing/run', { project_id: project }], ['/api/processing/jobs/' + '0'.repeat(64) + '/retry', {}],
        ['/api/processing/jobs/' + '0'.repeat(64) + '/dismiss', {}]];
      for (const [path, body] of writes) {
        for (const token of [undefined, tokens.read, tokens.mcp, tokens.mbp]) assert.equal((await post(path, body, token)).status, 403, `${path} ${token}`);
        assert.equal((await post(path, body, tokens.review, { Origin: 'https://hostile.invalid' })).status, 403);
      }
      // Disabled by default: running a scope is refused, never forced.
      assert.equal((await post('/api/processing/run', { project_id: project }, tokens.review)).status, 409);
      assert.equal((await post('/api/processing/jobs/' + '0'.repeat(64) + '/retry', {}, tokens.review)).status, 404);
      assert.equal((await post('/api/processing/budget', {}, tokens.review)).status, 404);
      assert.equal((await post('/api/processing/policies', { ...openPolicy, scope_type: 'workspace', scope_id: '*', extra: 1 }, tokens.review)).status, 400);
      const saved = await post('/api/processing/policies', { ...openPolicy, scope_type: 'workspace', scope_id: '*', summary_fields: ['command_text'] }, tokens.review);
      assert.equal(saved.status, 200);
      assert.equal(((await saved.json()) as any).workspace.updated_by, 'reviewer:' + hash(tokens.review).slice(0, 16));
    });

    let contextId = '', jobId = '';
    await t.test('the hourly cron leaves processing alone; the frequent cron plans and runs a job', async () => {
      assert.equal((await worker.scheduled({ cron: '17 * * * *', scheduledTime: new Date(Date.now() + 120 * 60_000) })).outcome, 'ok');
      assert.equal(((await (await get('/api/processing/jobs', tokens.read)).json()) as any).jobs.length, 0);
      assert.equal((await frequent(120)).outcome, 'ok');
      const listed = ((await (await get('/api/processing/jobs', tokens.read)).json()) as any).jobs;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].status, 'succeeded'); assert.equal(listed[0].covered_count, 3);
      jobId = listed[0].id; contextId = listed[0].result_context_id;
      const context = ((await (await get('/api/context/' + contextId, tokens.read)).json()) as any).context;
      assert.equal(context.status, 'pending'); assert.equal(context.origin, 'pipeline');
      assert.equal(context.audit[0].actor, 'pipeline:beacon.extractive@1');
      // Default recall still returns only approved knowledge.
      assert.equal(((await (await get('/api/context', tokens.read)).json()) as any).context.length, 0);
    });

    await t.test('approving a pipeline candidate still requires REVIEW_TOKEN', async () => {
      for (const token of [undefined, tokens.read, tokens.mcp, tokens.mbp])
        assert.equal((await post(`/api/context/${contextId}/review`, { decision: 'approve' }, token)).status, 403);
      const approved = await post(`/api/context/${contextId}/review`, { decision: 'approve', reason: 'Synthetic review' }, tokens.review);
      assert.equal(approved.status, 200);
      assert.equal(((await approved.json()) as any).context.authoritative, true);
    });

    await t.test('read-only MCP tools list and read processing jobs', async () => {
      const client = new Client({ name: 'synthetic-processing-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + tokens.mcp } }, fetch: mf.dispatchFetch.bind(mf) as unknown as typeof fetch });
      try {
        await client.connect(transport);
        const tools = (await client.listTools()).tools.filter((tool) => tool.name.includes('processing'));
        assert.deepEqual(tools.map((tool) => tool.name).sort(), ['beacon_get_processing_job', 'beacon_list_processing_jobs']);
        assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint === false));
        const list = await client.callTool({ name: 'beacon_list_processing_jobs', arguments: { status: 'succeeded', limit: 5 } });
        assert.equal(list.isError, undefined);
        assert.equal((list.structuredContent as any).jobs[0].id, jobId);
        const detail = await client.callTool({ name: 'beacon_get_processing_job', arguments: { job_id: jobId } });
        assert.equal((detail.structuredContent as any).job.sources.length, 3);
        const missing = await client.callTool({ name: 'beacon_get_processing_job', arguments: { job_id: '0'.repeat(64) } });
        assert.equal(missing.isError, true);
      } finally { await client.close(); }
    });

    await t.test('ingest keeps acknowledging when processing tables are gone, and the cron still completes', async () => {
      for (const table of ['processing_job_fence', 'processing_coverage', 'processing_job_sources', 'processing_signals', 'processing_calls',
        'processing_job_audit', 'context_generation', 'processing_jobs', 'processing_policy_audit', 'processing_policies',
        'processing_budget_audit', 'processing_budget', 'processing_scan_cursor'])
        await db.prepare(`DROP TABLE ${table}`).run();
      assert.equal((await upload([workflowEvent('worker-after-drop')])).status, 200);
      assert.equal((await frequent(240)).outcome, 'ok');
      assert.equal((await upload([workflowEvent('worker-after-tick', 'alpha', 'mini-session')], tokens.mini)).status, 200);
      assert.equal((await get('/api/processing/jobs', tokens.read)).status, 503);
    });
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});
