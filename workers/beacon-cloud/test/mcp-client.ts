import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type FetchFunction = NonNullable<ConstructorParameters<typeof StreamableHTTPClientTransport>[1]>['fetch'];

/** Runs against the actual Worker router; uses only caller-provided synthetic data. */
export async function verifyMcp(url: string, token: string, sessionId?: string, fetchImpl?: FetchFunction) {
  const summaries = [];
  for (const modern of [true, false]) {
    const client = new Client({ name: 'beacon-e2e-synthetic', version: '1.0.0' },
      modern ? { versionNegotiation: { mode: 'auto' } } : {});
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } }, fetch: fetchImpl,
    });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), modern ? 'modern' : 'legacy');
      const { tools } = await client.listTools();
      assert.equal(tools.length, 13);
      for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true);
      const sessions = await client.callTool({ name: 'beacon_list_sessions', arguments: { limit: 40 } });
      const devices = await client.callTool({ name: 'beacon_list_devices', arguments: {} });
      const projects = await client.callTool({ name: 'beacon_list_projects', arguments: {} });
      for (const result of [sessions, devices, projects]) assert.equal(result.isError, undefined);
      const timeline = sessionId ? await client.callTool({ name: 'beacon_get_timeline', arguments: { session_id: sessionId, limit: 40 } }) : undefined;
      if (timeline) assert.equal(timeline.isError, undefined);
      summaries.push({ era: client.getProtocolEra(), sessions: sessions.structuredContent, devices: devices.structuredContent, projects: projects.structuredContent, timeline: timeline?.structuredContent });
    } finally { await client.close(); }
  }
  return summaries;
}
