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

test('the Mac sync preview asks for exactly what the device receives, shared memories included, and the card and form show the grant', async () => {
  const script = await dashboardScriptResponse().text();
  const extract = (name: string) => {
    const start = script.search(new RegExp(`\\n  (?:async )?function ${name}\\(`)) + 1;
    return script.slice(start, script.indexOf('\n  }\n', start) + 4).trim();
  };
  type Node = { tag: string; text: string; children: Node[]; append(...items: Node[]): void; replaceChildren(...items: Node[]): void; textContent?: string };
  const node = (tag = 'div', text = ''): Node => ({ tag, text, children: [], append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; } });
  const all = (root: Node): string[] => [root.text, root.textContent ?? '', ...root.children.flatMap(all)].filter(Boolean);
  const elements: Record<string, any> = { 'sync-preview': node(), 'sync-preview-heading': node(), 'sync-list': node(), 'sync-count': node(),
    'more-sync': { hidden: false }, 'sync-device': { value: 'mbp' }, 'sync-project': { value: 'b'.repeat(64) },
    'sync-kind-memory': { checked: true }, 'sync-kind-summary': { checked: false }, 'sync-include-shared': { checked: true } };
  const requests: string[] = [];
  const snapshot = { kinds: ['memory'], entry_count: 2, snapshot_sha256: 'f'.repeat(64), entries: [
    { id: 'own', kind: 'memory', title: 'Synthetic own', content: 'own', content_sha256: '1'.repeat(64), reviewed_at: '2026-10-09T00:00:00.000Z' },
    { id: 'shared', kind: 'memory', title: 'Synthetic shared', content: 'shared', content_sha256: '2'.repeat(64), reviewed_at: '2026-10-09T00:00:01.000Z',
      shared_from_project_id: 'a'.repeat(64), share_id: 'share-1' }] };
  const context: Record<string, unknown> = {
    URLSearchParams, byId: (id: string) => elements[id], text: (tag: string, value: string) => node(tag, value), button: (value: string) => node('button', value),
    date: (value: string) => 'DATE(' + value + ')', document: { createElement: (tag: string) => node(tag) },
    api: async (path: string) => { requests.push(path); return { snapshot }; },
    syncState: { items: [], cursor: null, previewVersion: 0, projectNames: { ['a'.repeat(64)]: 'synthetic/alpha' } },
    syncKindLabels: { memory: '長期記憶', summary: '交接摘要' }, syncKindText: (kinds: string[]) => kinds.join('、'), syncSharedText: '含其他專案共享的長期記憶',
  };
  const load = (name: string) => new Script(`(${extract(name).replace(new RegExp(`^(async )?function ${name}`), '$1function')})`).runInNewContext(context);
  if (script.includes('function syncPreviewQuery(')) context.syncPreviewQuery = load('syncPreviewQuery');
  context.previewSyncSubscription = load('previewSyncSubscription');
  const item = { id: 's', project_id: 'b'.repeat(64), project_name: 'synthetic/beta', device_id: 'mbp', kinds: ['memory'], status: 'active',
    include_shared: true, created_at: '2026-10-09T00:00:00.000Z' };
  await (context.previewSyncSubscription as (value: unknown) => Promise<void>)(item);
  assert.deepEqual(requests, ['/api/context/snapshot?project_id=' + 'b'.repeat(64) + '&kind=memory&include_shared=1']);
  const preview = all(elements['sync-preview']).join('\n'), heading = elements['sync-preview-heading'].textContent;
  assert.match(heading, /含其他專案共享的長期記憶/);
  assert.match(heading, /其中 1 份來自其他專案/);
  assert.match(preview, /共享自 synthetic\/alpha/);
  assert.match(preview, /共享 share-1/);
  // A plain grant previews without shared entries, exactly as its device reads.
  requests.length = 0;
  await (context.previewSyncSubscription as (value: unknown) => Promise<void>)({ ...item, include_shared: false, kinds: ['memory', 'summary'] });
  assert.deepEqual(requests, ['/api/context/snapshot?project_id=' + 'b'.repeat(64) + '&include_shared=0']);
  // The card names the setting, so grants that carry other projects' memories stand out.
  context.renderSyncSubscriptions = load('renderSyncSubscriptions');
  (context.syncState as any).items = [item, { ...item, id: 't', include_shared: false }];
  (context.renderSyncSubscriptions as () => void)();
  const cards = elements['sync-list'].children.map((card: Node) => all(card).join(' '));
  assert.match(cards[0], /memory · 含其他專案共享的長期記憶/);
  assert.doesNotMatch(cards[1], /共享/);
  // The create form can grant it, and only together with long-term memories.
  const created = load('syncCreateBody') as () => Record<string, unknown>, body = () => JSON.parse(JSON.stringify(created()));
  assert.deepEqual(body(), { device_id: 'mbp', project_id: 'b'.repeat(64), kinds: ['memory'], include_shared: true });
  elements['sync-kind-memory'].checked = false; elements['sync-kind-summary'].checked = true;
  assert.throws(() => body(), /長期記憶/);
  elements['sync-include-shared'].checked = false;
  assert.deepEqual(body().include_shared, false);
  assert.match(await dashboardResponse().text(), /id="sync-include-shared"/);
});
