import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Forwarder, runOnce, loadConfig, prepareEvent } from './forwarder.mjs';

// All telemetry, paths and credentials below are synthetic and local to t's directory.
function event(id, extra = {}) {
  return { timestamp: '2026-01-01T00:00:00Z', vendor: 'beacon', product: 'endpoint-agent', schema_version: '1.0',
    event: { id, kind: 'agent_runtime', action: 'session.started' }, severity: 'info',
    endpoint: { hostname: 'synthetic-device', os: 'darwin' }, harness: { name: 'claude_code' },
    session: { id: 'synthetic-session', working_directory: '/synthetic/checkout/src' }, ...extra };
}

const jsonl = (events) => events.map((value) => `${JSON.stringify(value)}\n`).join('');
const hash = value => createHash('sha256').update(value).digest('hex');
const responseJSON = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const healthResponse = (device = 'synthetic-device') => responseJSON({ status: 'ok', device_id: device });
const withHealth = (handler, device = 'synthetic-device') => async (url, options) => url.endsWith('/health') ? healthResponse(device) : handler(url, options);
const acknowledgement = (url, options, device = 'synthetic-device') => responseJSON({
  batch_id: hash(JSON.stringify([device, url.endsWith('/inventory') ? 'inventory' : 'runtime', hash(options.body)])),
  accepted: options.body.trim().split('\n').length, inserted: options.body.trim().split('\n').length, duplicate: false,
});

async function fixture(t, override = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'beacon-forwarder-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime.jsonl');
  const inventory = join(root, 'inventory_state.jsonl');
  const tokenFile = join(root, 'token.txt');
  await fs.writeFile(tokenFile, 'synthetic-device-token\n', { mode: 0o600 });
  const config = { endpoint: 'http://127.0.0.1:8787', allowLocalHttp: true,
    stateDir: join(root, 'state'), tokenFile,
    streams: { runtime: { path: runtime, readFrom: 'beginning' } }, ...override };
  const requests = [];
  const fetchImpl = withHealth(async (url, options) => { requests.push({ url, ...options }); return acknowledgement(url, options); });
  return { root, runtime, inventory, tokenFile, config, requests, fetchImpl };
}

test('ships unchanged upstream schema with token auth; preserves nested event.id', async (t) => {
  const f = await fixture(t);
  const source = event('upstream-id', { raw: { synthetic: 'not a real transcript' } });
  await fs.writeFile(f.runtime, jsonl([source]));
  assert.deepEqual(await runOnce(f.config, { fetchImpl: f.fetchImpl }), { queued: 1, full: false, sent: 1, blocked: null, pendingBatches: 0 });
  assert.equal(f.requests[0].url, 'http://127.0.0.1:8787/v1/ingest/runtime');
  assert.equal(f.requests[0].headers.Authorization, 'Bearer synthetic-device-token');
  assert.equal(f.requests[0].headers['Content-Type'], 'application/x-ndjson');
  assert.equal(f.requests[0].redirect, 'error');
  assert.deepEqual(JSON.parse(f.requests[0].body), source);
  assert.equal((await fs.stat(join(f.config.stateDir, 'checkpoint.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.config.stateDir)).mode & 0o777, 0o700);
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 0);
});

test('connection outage persists outbox and retries after process restart without rereading source', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('offline-event')]));
  let result = await runOnce(f.config, { fetchImpl: withHealth(async () => { throw new Error('do not log secrets'); }) });
  assert.equal(result.blocked, 'NETWORK_UNAVAILABLE');
  assert.equal(result.pendingBatches, 1);
  const queueName = (await fs.readdir(join(f.config.stateDir, 'outbox')))[0];
  const queueBody = await fs.readFile(join(f.config.stateDir, 'outbox', queueName), 'utf8');
  assert.equal(queueBody.includes('synthetic-device-token'), false);
  assert.equal((await fs.stat(join(f.config.stateDir, 'outbox', queueName))).mode & 0o777, 0o600);
  await fs.rm(f.runtime);
  result = await runOnce(f.config, { fetchImpl: f.fetchImpl });
  assert.equal(result.queued, 0);
  assert.equal(result.sent, 1);
  assert.equal(JSON.parse(f.requests[0].body).event.id, 'offline-event');
});

test('uncertain acknowledgement resends the exact same event identity and body', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('retry-event')]));
  let acceptedBody;
  await runOnce(f.config, { fetchImpl: withHealth(async (_url, request) => { acceptedBody = request.body; throw new Error('socket closed after commit'); }) });
  await runOnce(f.config, { fetchImpl: f.fetchImpl });
  assert.equal(f.requests[0].body, acceptedBody);
});

test('checkpoint crash recovery reuses existing durable batch and never advances without a queue', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('crash-event')]));
  await runOnce(f.config, { fetchImpl: withHealth(async () => { throw new Error('offline'); }) });
  const statePath = join(f.config.stateDir, 'checkpoint.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  Object.values(state.streams.runtime.files)[0].offset = 0;
  await fs.writeFile(statePath, JSON.stringify(state));
  const result = await runOnce(f.config, { fetchImpl: f.fetchImpl });
  assert.equal(result.queued, 0);
  assert.equal(result.sent, 1);
  assert.equal(f.requests.length, 1);
});

test('rotations follow physical files and replay unread lines in renamed archives', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('before-rotation')]));
  await runOnce(f.config, { fetchImpl: f.fetchImpl });
  await fs.appendFile(f.runtime, jsonl([event('unread-in-archive')]));
  await fs.rename(f.runtime, `${f.runtime}.1`);
  await fs.writeFile(f.runtime, jsonl([event('after-rotation')]));
  const result = await runOnce(f.config, { fetchImpl: f.fetchImpl });
  assert.equal(result.sent, 2);
  const ids = f.requests.flatMap((request) => request.body.trim().split('\n').map((line) => JSON.parse(line).event.id));
  assert.deepEqual(ids.sort(), ['before-rotation', 'unread-in-archive', 'after-rotation'].sort());
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 0);
});

test('copytruncate resets changed prefix even when rewritten file is longer than old offset', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('old-generation')]));
  await runOnce(f.config, { fetchImpl: f.fetchImpl });
  await fs.writeFile(f.runtime, jsonl([event('new-generation-with-more-bytes'), event('second-new')]));
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 2);
});

test('partial JSONL lines remain unread and append completes exactly one event', async (t) => {
  const f = await fixture(t);
  const line = JSON.stringify(event('partial'));
  await fs.writeFile(f.runtime, line.slice(0, 50));
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 0);
  await fs.appendFile(f.runtime, `${line.slice(50)}\n`);
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 1);
});

test('runtime consent boundary skips history and any existing partial line', async (t) => {
  const f = await fixture(t);
  f.config.streams.runtime.readFrom = 'end';
  const prior = JSON.stringify(event('prior-partial'));
  await fs.writeFile(f.runtime, `${jsonl([event('prior-complete')])}${prior.slice(0, 100)}`);
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 0);
  await fs.appendFile(f.runtime, `${prior.slice(100)}\n${jsonl([event('after-consent')])}`);
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 1);
  assert.equal(JSON.parse(f.requests[0].body).event.id, 'after-consent');
});

test('source first created after initialization is read from beginning', async (t) => {
  const f = await fixture(t);
  f.config.streams.runtime.readFrom = 'end';
  await runOnce(f.config, { fetchImpl: f.fetchImpl });
  await fs.writeFile(f.runtime, jsonl([event('new-file')]));
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 1);
});

test('legacy inventory gets deterministic ID and independent inventory endpoint', async (t) => {
  const f = await fixture(t);
  f.config.streams.inventory = { path: f.inventory, readFrom: 'beginning' };
  const inventory = event(undefined, { event: { kind: 'agent_runtime', action: 'inventory.snapshot' } });
  await fs.writeFile(f.inventory, jsonl([inventory]));
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 1);
  assert.equal(f.requests[0].url.endsWith('/inventory'), true);
  const id = JSON.parse(f.requests[0].body).event.id;
  assert.match(id, /^forwarder-sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.parse(prepareEvent(Buffer.from(JSON.stringify(inventory)), { projectMappings: [] })).event.id, id);
});

test('project mappings use longest absolute path prefix without rewriting observed remote', async (t) => {
  const f = await fixture(t, { projectMappings: [
    { path: '/synthetic', remote: 'https://github.com/Example/general.git' },
    { path: '/synthetic/checkout', remote: 'git@github.com:Example/specific.git' },
  ] });
  await fs.writeFile(f.runtime, jsonl([
    event('mapped'),
    event('observed', { vcs: { repository: { url: { full: 'https://github.com/Example/observed.git' } } } }),
    event('not-prefix', { session: { id: 'test', working_directory: '/synthetic-copy/src' } }),
  ]));
  await runOnce(f.config, { fetchImpl: f.fetchImpl });
  const [mapped, observed, unrelated] = f.requests[0].body.trim().split('\n').map(JSON.parse);
  assert.equal(mapped.project.remote, 'git@github.com:Example/specific.git');
  assert.equal(observed.project, undefined);
  assert.equal(unrelated.project, undefined);
});

test('file URL repository context allows explicit mapping and retains source fields and fallback identity', async (t) => {
  const f = await fixture(t, { projectMappings: [{ path: '/synthetic/checkout', remote: 'https://github.com/Example/canonical.git' }] });
  const source = event(undefined, { vcs: { repository: { url: { full: 'file:///synthetic/checkout' } } }, repository: '/synthetic/checkout' });
  const line = Buffer.from(JSON.stringify(source));
  const withoutMapping = JSON.parse(prepareEvent(line, { projectMappings: [] }));
  const withMapping = JSON.parse(prepareEvent(line, await loadConfig(f.config)));
  assert.equal(withMapping.project.remote, 'https://github.com/Example/canonical.git');
  assert.deepEqual(withMapping.vcs, source.vcs);
  assert.equal(withMapping.repository, source.repository);
  assert.equal(withMapping.event.id, withoutMapping.event.id);
});

test('observed top-level and run repository Git remotes prevent mapping override', async (t) => {
  const f = await fixture(t, { projectMappings: [{ path: '/synthetic/checkout', remote: 'https://github.com/Example/mapping.git' }] });
  const config = await loadConfig(f.config);
  for (const source of [event('top-level-remote', { repository: 'https://github.com/Example/observed.git' }),
    event('run-remote', { run: { repository: 'git@github.com:Example/run.git' } })]) {
    const prepared = JSON.parse(prepareEvent(Buffer.from(JSON.stringify(source)), config));
    assert.equal(prepared.project, undefined);
    assert.deepEqual(prepared, source);
  }
});

test('batch boundaries enforce 100 events and configured byte limit', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl(Array.from({ length: 205 }, (_v, n) => event(`batch-${n}`))));
  const result = await runOnce(f.config, { fetchImpl: f.fetchImpl });
  assert.equal(result.sent, 205);
  assert.deepEqual(f.requests.map((request) => request.body.trim().split('\n').length).sort((a, b) => a - b), [5, 100, 100]);
  for (const request of f.requests) assert.ok(Buffer.byteLength(request.body) <= 1048576);
});

test('byte limit splits a batch before its event-count limit', async (t) => {
  const f = await fixture(t, { maxBatchBytes: 1000 });
  await fs.writeFile(f.runtime, jsonl(Array.from({ length: 5 }, (_v, n) => event(`bytes-${n}`))));
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 5);
  assert.ok(f.requests.length > 1);
  for (const request of f.requests) assert.ok(Buffer.byteLength(request.body) <= 1000);
});

test('full outbox blocks checkpoint advancement and later resumes', async (t) => {
  const f = await fixture(t, { maxQueueBytes: 1 });
  await fs.writeFile(f.runtime, jsonl([event('blocked-by-quota')]));
  let result = await runOnce(f.config, { fetchImpl: f.fetchImpl });
  assert.equal(result.full, true);
  assert.equal(result.sent, 0);
  const state = JSON.parse(await fs.readFile(join(f.config.stateDir, 'checkpoint.json'), 'utf8'));
  assert.equal(Object.values(state.streams.runtime.files)[0].offset, 0);
  f.config.maxQueueBytes = 100000;
  result = await runOnce(f.config, { fetchImpl: f.fetchImpl });
  assert.equal(result.sent, 1);
});

test('HTTP authentication/validation/server failures keep queued events and redact response bodies', async (t) => {
  for (const status of [401, 403, 413, 422, 429, 503]) {
    const f = await fixture(t);
    await fs.writeFile(f.runtime, jsonl([event(`failed-${status}`)]));
    const result = await runOnce(f.config, { fetchImpl: withHealth(async () => new Response('private server body', { status })) });
    assert.equal(result.blocked, `HTTP_${status}`);
    assert.equal(result.pendingBatches, 1);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('invalid JSON and oversized events fail without advancing or exposing content', async (t) => {
  const f = await fixture(t, { maxBatchBytes: 600 });
  await fs.writeFile(f.runtime, 'private-unparseable-content\n');
  await assert.rejects(runOnce(f.config, { fetchImpl: f.fetchImpl }), { message: 'INVALID_SOURCE_JSON' });
  await fs.writeFile(f.runtime, jsonl([event('too-large', { message: 'x'.repeat(2000) })]));
  await assert.rejects(runOnce(f.config, { fetchImpl: f.fetchImpl }), { message: 'SOURCE_LINE_TOO_LARGE' });
  assert.equal(f.requests.length, 0);
});

test('config rejects insecure endpoint, credential-bearing remote and impossible limits', async (t) => {
  const f = await fixture(t);
  await assert.rejects(loadConfig({ ...f.config, endpoint: 'http://example.com' }), { message: 'HTTPS_REQUIRED' });
  await assert.rejects(loadConfig({ ...f.config, endpoint: 'https://token@example.com' }), { message: 'INVALID_ENDPOINT' });
  await assert.rejects(loadConfig({ ...f.config, maxBatchEvents: 101 }), { message: 'INVALID_BATCH_EVENTS' });
  await assert.rejects(loadConfig({ ...f.config, projectMappings: [{ path: '/synthetic', remote: 'https://token:secret@example.com/repo' }] }), { message: 'PROJECT_REMOTE_CONTAINS_CREDENTIALS' });
});

test('forwarder rejects shared state, shared token, symlink token, and concurrent instance', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.config.stateDir, { mode: 0o755 });
  await assert.rejects(Forwarder.open(f.config), { message: 'PRIVATE_STATE_DIRECTORY_REQUIRED' });
  await fs.chmod(f.config.stateDir, 0o700);
  const first = await Forwarder.open(f.config, { fetchImpl: f.fetchImpl });
  await assert.rejects(Forwarder.open(f.config), { message: 'FORWARDER_LOCKED' });
  await first.close();
  await fs.writeFile(f.runtime, jsonl([event('private-token')]));
  await fs.chmod(f.tokenFile, 0o644);
  await assert.rejects(runOnce(f.config, { fetchImpl: f.fetchImpl }), { message: 'PRIVATE_TOKEN_FILE_REQUIRED' });
  await fs.chmod(f.tokenFile, 0o600);
  const link = join(f.root, 'token-link');
  await fs.symlink(f.tokenFile, link);
  await assert.rejects(runOnce({ ...f.config, tokenFile: link }, { fetchImpl: f.fetchImpl }), { message: 'PRIVATE_TOKEN_FILE_REQUIRED' });
});

test('config path is accepted for the local producer to workerd e2e harness', async (t) => {
  const f = await fixture(t);
  const configPath = join(f.root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(f.config));
  await fs.writeFile(f.runtime, jsonl([event('from-config-path')]));
  assert.equal((await runOnce(configPath, { fetchImpl: f.fetchImpl })).sent, 1);
});

test('successful HTTP without a bounded exact Worker acknowledgement never deletes queued telemetry', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('ack-checked')]));
  const invalid = [
    () => new Response('<html>login page</html>', { status: 200 }),
    () => responseJSON({}),
    () => responseJSON({ batch_id: 'wrong-batch', accepted: 1 }),
    (url, options) => {
      const expected = hash(JSON.stringify(['synthetic-device', 'runtime', hash(options.body)]));
      return responseJSON({ batch_id: expected, accepted: 0 });
    },
    () => responseJSON({ body: 'x'.repeat(6000) }),
  ];
  for (const handler of invalid) {
    const result = await runOnce(f.config, { fetchImpl: withHealth(handler) });
    assert.equal(result.sent, 0);
    assert.equal(result.blocked, 'INVALID_INGEST_ACK');
    assert.equal(result.pendingBatches, 1);
  }
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 1);
});

test('fresh offline startup defers sources until authenticated destination binding is durable', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('fresh-offline')]));
  const failed = await runOnce(f.config, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(failed, { queued: 0, full: false, sent: 0, blocked: 'NETWORK_UNAVAILABLE', pendingBatches: 0 });
  await assert.rejects(fs.access(join(f.config.stateDir, 'checkpoint.json')), { code: 'ENOENT' });
  assert.equal((await runOnce(f.config, { fetchImpl: f.fetchImpl })).sent, 1);
  const state = JSON.parse(await fs.readFile(join(f.config.stateDir, 'checkpoint.json'), 'utf8'));
  assert.deepEqual(state.destination, { endpoint: f.config.endpoint, deviceId: 'synthetic-device' });
});

test('bound offline startup queues locally and verifies same-device token rotation before later drain', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('before-offline')]));
  await runOnce(f.config, { fetchImpl: f.fetchImpl });
  await fs.appendFile(f.runtime, jsonl([event('while-offline')]));
  await fs.writeFile(f.tokenFile, 'synthetic-new-same-device-token');
  const offline = await runOnce(f.config, { fetchImpl: async () => { throw new Error('health unreachable'); } });
  assert.deepEqual(offline, { queued: 1, full: false, sent: 0, blocked: 'NETWORK_UNAVAILABLE', pendingBatches: 1 });
  assert.equal(f.requests.length, 1);
  const resumed = await runOnce(f.config, { fetchImpl: f.fetchImpl });
  assert.equal(resumed.sent, 1);
  assert.equal(f.requests[1].headers.Authorization, 'Bearer synthetic-new-same-device-token');
});

test('endpoint and device namespace changes reject before sending or advancing bound source checkpoints', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('private-original-destination')]));
  await runOnce(f.config, { fetchImpl: withHealth(async () => { throw new Error('upload uncertain'); }) });
  const checkpointPath = join(f.config.stateDir, 'checkpoint.json');
  const prior = await fs.readFile(checkpointPath, 'utf8');
  let calls = 0;
  await assert.rejects(runOnce({ ...f.config, endpoint: 'http://localhost:9999' }, { fetchImpl: async () => { calls++; return healthResponse(); } }),
    { message: 'ENDPOINT_NAMESPACE_MISMATCH' });
  assert.equal(calls, 0);
  await fs.appendFile(f.runtime, jsonl([event('new-source-event')]));
  await assert.rejects(runOnce(f.config, { fetchImpl: withHealth(async () => { calls++; return responseJSON({}); }, 'different-device') }),
    { message: 'DEVICE_NAMESPACE_MISMATCH' });
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(checkpointPath, 'utf8'), prior);
  assert.equal((await fs.readdir(join(f.config.stateDir, 'outbox'))).length, 1);
});

test('legacy unbound source checkpoints fail closed instead of adopting a destination', async (t) => {
  for (const keepOutbox of [true, false]) {
    const f = await fixture(t);
    await fs.writeFile(f.runtime, jsonl([event('legacy-private-source')]));
    await runOnce(f.config, { fetchImpl: keepOutbox ? withHealth(async () => { throw new Error('offline'); }) : f.fetchImpl });
    const checkpointPath = join(f.config.stateDir, 'checkpoint.json');
    const state = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    delete state.destination;
    await fs.writeFile(checkpointPath, JSON.stringify(state));
    let called = false;
    await assert.rejects(runOnce(f.config, { fetchImpl: async () => { called = true; return healthResponse(); } }), { message: 'UNBOUND_EXISTING_STATE' });
    assert.equal(called, false);
    assert.equal((await fs.readdir(join(f.config.stateDir, 'outbox'))).length, keepOutbox ? 1 : 0);
  }
});

test('native HTTP redirects never forward the bearer credential to another destination', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.runtime, jsonl([event('redirect-protected')]));
  let redirectedCalls = 0;
  const target = createServer((_request, response) => { redirectedCalls++; response.end('not the Worker'); });
  await new Promise(done => target.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => target.close(done)));
  const targetURL = `http://127.0.0.1:${target.address().port}/elsewhere`;
  const origin = createServer((request, response) => {
    request.resume();
    if (request.url === '/v1/ingest/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', device_id: 'synthetic-device' }));
    } else { response.writeHead(307, { Location: targetURL }); response.end(); }
  });
  await new Promise(done => origin.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => origin.close(done)));
  f.config.endpoint = `http://127.0.0.1:${origin.address().port}`;
  const result = await runOnce(f.config);
  assert.equal(result.blocked, 'NETWORK_UNAVAILABLE');
  assert.equal(result.pendingBatches, 1);
  assert.equal(redirectedCalls, 0);
});
