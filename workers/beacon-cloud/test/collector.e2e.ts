import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
// @ts-expect-error Deliberately independent Node-only helper invokes the shipping Go hook binary.
import { produceBeaconFixture } from './collector-fixture.mjs';
// @ts-expect-error The opt-in shipper is a standalone Node module.
import { runOnce } from '../forwarder/forwarder.mjs';

test('compiled shipping Beacon hook -> JSONL -> forwarder -> workerd -> D1/R2 -> query survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-shipping-producer-'));
  const deviceToken = 'synthetic-compiled-hook-device-token-000000';
  const readToken = 'synthetic-compiled-hook-read-token-00000000';
  const options = convertV4MiniflareOptions({ resourcePersistencePath: join(directory, 'storage'), workers: [{
    name: 'beacon-shipping-producer', modules: true as const, scriptPath: resolve('dist/worker.mjs'), compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'beacon-shipping-producer-index' }, r2Buckets: { RAW: 'beacon-shipping-producer-raw' },
    bindings: { READ_TOKEN: readToken, MCP_TOKEN: 'synthetic-unused-mcp-token-00000000000000' },
  }] });
  let mf = new Miniflare(options);
  const read = (path: string) => mf.dispatchFetch(`http://localhost${path}`, { headers: { Authorization: `Bearer ${readToken}` } });
  try {
    const fixture = await produceBeaconFixture(directory);
    for (const event of fixture.events) {
      assert.equal(event.vendor, 'beacon'); assert.equal(event.product, 'endpoint-agent');
      assert.equal(event.schema_version, '1.0'); assert.equal(event.harness.name, 'claude_code');
      assert.equal(event.harness.collection_method, 'hook'); assert.equal(event.session.id, fixture.sessionId);
      assert.equal(event.origin, 'local'); assert.match(event.event.id, /^[a-f0-9-]{36}$/);
    }
    const command = fixture.events.find((event: any) => event.event.action === 'command.executed');
    assert.equal(command.command.command, `echo ${fixture.canary}`);
    // The upstream generic Claude hook mapper currently retains the command,
    // but does not promote tool_response.exit_code or stdout into command.*.
    assert.equal(command.command.exit_code, undefined);
    assert.equal(command.gen_ai.tool.call.id, 'synthetic-bash-tool-call');
    const tokenFile = join(directory, 'device-token');
    await writeFile(tokenFile, deviceToken, { mode: 0o600 });
    let db = await mf.getD1Database('DB');
    const [tables, trigger] = (await readFile('migrations/0001_initial.sql', 'utf8')).split('CREATE TRIGGER');
    for (const statement of tables.replace(/--[^\n]*/g, '').split(';').filter(value => value.trim())) await db.prepare(statement).run();
    await db.prepare('CREATE TRIGGER' + trigger).run();
    await db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').bind('synthetic-hook-device', 'Synthetic hook device',
      createHash('sha256').update(deviceToken).digest('hex'), '2026-10-04T00:00:00Z').run();
    const config = { endpoint: 'http://localhost', tokenFile, stateDir: join(directory, 'forwarder-state'), allowLocalHttp: true,
      streams: { runtime: { path: fixture.logPath, readFrom: 'beginning' } },
      projectMappings: [{ path: fixture.workspace, remote: 'git@github.com:Example/Shipping-Hook-Fixture.git' }] };
    const configPath = join(directory, 'forwarder-config.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    assert.deepEqual(await runOnce(configPath, { fetchImpl: mf.dispatchFetch.bind(mf) }),
      { queued: 2, full: false, sent: 2, blocked: null, pendingBatches: 0 });
    const query = await (await read('/api/sessions')).json() as any;
    assert.equal(query.sessions.length, 1); assert.equal(query.sessions[0].event_count, 2);
    assert.equal(query.sessions[0].source_session_id, fixture.sessionId);
    const timeline = await (await read(`/api/sessions/${query.sessions[0].id}/events`)).json() as any;
    assert.deepEqual(timeline.events.map((item: any) => item.event_id).sort(), fixture.events.map((event: any) => event.event.id).sort());
    const stored = timeline.events.find((item: any) => item.action === 'command.executed').payload;
    assert.equal(stored.command.command, command.command.command);
    assert.deepEqual(stored.gen_ai.tool.call, command.gen_ai.tool.call);
    assert.equal(stored.project.remote, config.projectMappings[0].remote);
    const batch = await db.prepare('SELECT r2_key FROM batches').first<{ r2_key: string }>();
    const rawObject = await (await mf.getR2Bucket('RAW')).get(batch!.r2_key);
    assert.equal((await rawObject!.text()).trim().split('\n').length, 2);
    await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database('DB');
    const persisted = await (await read(`/api/sessions/${query.sessions[0].id}/events`)).json() as any;
    assert.equal(persisted.events.length, 2);
    assert.equal((await runOnce(configPath, { fetchImpl: mf.dispatchFetch.bind(mf) })).sent, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>())!.count, 2);
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});
