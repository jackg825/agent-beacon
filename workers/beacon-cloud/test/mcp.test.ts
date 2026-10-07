import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { handleMcp } from '../src/mcp';
import type { Env } from '../src/types';

const env = {} as Env;
const endpoint = new URL('https://beacon.example.invalid/mcp');

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

test('official current MCP client discovers and lists only read-only tools', async () => {
  const client = new Client({ name: 'beacon-synthetic-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: (input, init) => handleMcp(new Request(input, init), env),
  });
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'beacon_get_timeline', 'beacon_list_devices', 'beacon_list_projects', 'beacon_list_sessions',
      'beacon_list_project_groups', 'beacon_get_project_group', 'beacon_list_project_relations',
      'beacon_list_tasks', 'beacon_get_task', 'beacon_list_context', 'beacon_get_context',
      'beacon_get_event', 'beacon_list_event_versions',
    ].sort());
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
  } finally { await client.close(); }
});

test('official legacy MCP client can initialize and list the same tools', async () => {
  const client = new Client({ name: 'legacy-synthetic-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: (input, init) => handleMcp(new Request(input, init), env),
  });
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'legacy');
    assert.equal((await client.listTools()).tools.length, 13);
  } finally { await client.close(); }
});

test('cross-origin MCP calls, including notifications, are forbidden', async () => {
  for (const body of [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]) {
    const response = await handleMcp(post(body, { Origin: 'https://attacker.example.invalid' }), env);
    assert.equal(response.status, 403);
  }
});

test('MCP does not expose a GET stream or DELETE sessions', async () => {
  for (const method of ['GET', 'DELETE']) {
    const response = await handleMcp(new Request(endpoint, { method }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Mcp-Session-Id'), null);
  }
});

test('modern MCP rejects forged mirrored method metadata', async () => {
  const response = await handleMcp(post({
    jsonrpc: '2.0', id: 1, method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
  }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call' }), env);
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: number } }).error.code, -32020);
});

test('MCP refuses a request body beyond the bounded protocol size', async () => {
  const response = await handleMcp(post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { junk: 'x'.repeat(65536) } }), env);
  assert.equal(response.status, 413);
});
