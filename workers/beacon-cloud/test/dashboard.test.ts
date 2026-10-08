import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { dashboardResponse, dashboardScriptResponse } from '../src/dashboard';
import { panels } from '../src/dashboard-panels';

test('dashboard shell keeps data private and constrains script and network origins', async () => {
  const response = dashboardResponse();
  const html = await response.text();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const policy = response.headers.get('Content-Security-Policy')!;
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(html, /lang="zh-Hant"/);
  // The context notice states what background processing does and does not do.
  assert.match(html, /「自動整理・待審」候選/);
  assert.match(html, /不使用生成模型/);
  assert.match(html, /Jev 只留下未校準訊號，不能核准或修改筆記/);
  assert.doesNotMatch(html, /尚未提供/);
  assert.match(html, /原始事件維持保存/);
});

test('dashboard delivers valid JavaScript separately from its HTML', async () => {
  const response = dashboardScriptResponse();
  assert.match(response.headers.get('Content-Type')!, /text\/javascript/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const script = await response.text();
  assert.doesNotThrow(() => new Script(script));
});

test('every registered panel renders a tab, a hidden tabpanel and a loader', async () => {
  const html = await dashboardResponse().text();
  const script = await dashboardScriptResponse().text();
  const tabs = new Set(['activity', 'projects', 'context']);
  for (const panel of panels) {
    assert.match(panel.tab, /^[a-z][a-z-]{1,31}$/);
    assert.ok(!tabs.has(panel.tab), `duplicate tab ${panel.tab}`);
    tabs.add(panel.tab);
    assert.match(html, new RegExp(`id="tab-${panel.tab}" role="tab"`));
    assert.match(html, new RegExp(`<section id="view-${panel.tab}" role="tabpanel" aria-labelledby="tab-${panel.tab}" hidden>`));
    assert.match(script, new RegExp(`panelLoaders(?:\\.${panel.tab}|\\[['"]${panel.tab}['"]\\])\\s*=`));
  }
});
