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
  assert.match(html, /AI 自動 compact 尚未提供/);
  assert.match(html, /原始事件維持保存/);
});

test('dashboard delivers valid JavaScript separately from its HTML', async () => {
  const response = dashboardScriptResponse();
  assert.match(response.headers.get('Content-Type')!, /text\/javascript/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const script = await response.text();
  assert.doesNotThrow(() => new Script(script));
});

test('a processing job shows its next attempt only while queued', async () => {
  const script = await dashboardScriptResponse().text();
  const start = script.indexOf('  function renderProcessingJob(job) {');
  const source = script.slice(start, script.indexOf('\n  }\n', start) + 4);
  // Minimal stand-ins for the page helpers the function uses; text lands in `lines`.
  type Node = { text: string; children: unknown[]; append(...items: unknown[]): void; replaceChildren(): void };
  const node = (text = ''): Node => ({ text, children: [], append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; } });
  const container = node();
  const context = { byId: () => container, text: (_tag: string, value: string) => node(value), button: (value: string) => node(value),
    date: (value: string) => 'DATE(' + value + ')', processingScope: () => 'scope', processingStatus: {}, processingCode: (code: string) => code,
    processingQuestion: () => '', processingCallText: () => '' };
  const render = new Script(`(${source.trim().replace(/^function renderProcessingJob/, 'function')})`).runInNewContext(context);
  const lines = (job: Record<string, unknown>) => {
    render({ id: 'j', status: 'queued', attempts: 1, max_attempts: 4, next_attempt_at: '2026-10-09T12:05:00.000Z', source_count: 1, covered_count: 0,
      signals: [], calls: [], ...job });
    const all: string[] = [];
    const walk = (item: any) => { if (item && typeof item === 'object') { if (item.text) all.push(item.text); item.children.forEach(walk); } };
    walk(container);
    return all.join('\n');
  };
  assert.match(lines({ status: 'queued' }), /嘗試 1／4 · 下次 DATE\(2026-10-09T12:05:00\.000Z\)/);
  for (const status of ['failed', 'running', 'succeeded', 'skipped', 'dismissed']) {
    const text = lines({ status, attempts: 4 });
    assert.match(text, /嘗試 4／4/, status);
    assert.ok(!text.includes('下次'), status);
  }
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
