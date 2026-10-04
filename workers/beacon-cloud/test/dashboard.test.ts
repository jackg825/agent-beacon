import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { dashboardResponse, dashboardScriptResponse } from '../src/dashboard';

test('dashboard shell keeps data private and constrains script and network origins', async () => {
  const response = dashboardResponse();
  const html = await response.text();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const policy = response.headers.get('Content-Security-Policy')!;
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(html, /lang="zh-Hant"/);
  assert.match(html, /Memory 候選、審閱與核准尚未提供/);
});

test('dashboard delivers valid JavaScript separately from its HTML', async () => {
  const response = dashboardScriptResponse();
  assert.match(response.headers.get('Content-Type')!, /text\/javascript/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const script = await response.text();
  assert.doesNotThrow(() => new Script(script));
});
