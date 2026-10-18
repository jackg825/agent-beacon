import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dashboardResponse, dashboardScriptResponse } from '../src/dashboard.ts';

// Optional visual acceptance check: use an installed Playwright module, never a real account.
// BEACON_PLAYWRIGHT_MODULE can point to a bundled Playwright installation on the review host.
const { chromium } = await import(process.env.BEACON_PLAYWRIGHT_MODULE || 'playwright');
const password = 'synthetic-browser-password-do-not-use';
const authorization = 'Basic ' + Buffer.from('beacon:' + password).toString('base64');
const adversarial = '<img src=x onerror="window.__beaconInjected=true"><script>window.__beaconInjected=true</script>';
const sessions = [
  { id: 'central-mbp-session', source_session_id: 'shared-source-session', device_id: 'demo-mbp', device_name: '合成 MBP', project_id: 'demo-repo', project_name: '合成專案', harness: 'claude_code', started_at: '2026-10-04T00:00:00Z', last_event_at: '2026-10-04T00:00:02Z', event_count: 2 },
  { id: 'central-mini-session', source_session_id: 'shared-source-session', device_id: 'demo-mini', device_name: '合成 Mac mini', project_id: 'demo-repo', project_name: '合成專案', harness: 'codex_cli', started_at: '2026-10-04T00:00:00Z', last_event_at: '2026-10-04T00:00:01Z', event_count: 1 },
];

test('protected dashboard filters, paginates, renders untrusted events safely, and fits mobile', async () => {
  let deny = false;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== authorization || deny) {
      response.writeHead(deny ? 403 : 401, { 'WWW-Authenticate': 'Basic realm="Beacon synthetic browser check"' });
      response.end();
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    let result;
    if (url.pathname === '/') result = dashboardResponse();
    else if (url.pathname === '/dashboard.js') result = dashboardScriptResponse();
    else if (url.pathname === '/api/devices') result = Response.json({ devices: [ { id: 'demo-mbp', name: '合成 MBP' }, { id: 'demo-mini', name: '合成 Mac mini' } ] });
    else if (url.pathname === '/api/projects') result = Response.json({ projects: [{ id: 'demo-repo', name: '合成專案' }] });
    else if (url.pathname === '/api/project-groups') result = Response.json({ project_groups: [], next_cursor: null });
    else if (url.pathname === '/api/project-relations') result = Response.json({ relations: [], next_cursor: null });
    else if (url.pathname === '/api/tasks') result = Response.json({ tasks: [], next_cursor: null });
    else if (url.pathname === '/api/context') result = Response.json({ context: [], next_cursor: null });
    else if (url.pathname === '/api/sessions') {
      const filtered = sessions.filter((session) =>
        (!url.searchParams.get('device_id') || session.device_id === url.searchParams.get('device_id')) &&
        (!url.searchParams.get('project_id') || session.project_id === url.searchParams.get('project_id')) &&
        (!url.searchParams.get('harness') || session.harness === url.searchParams.get('harness')));
      const offset = url.searchParams.has('before') ? 1 : 0;
      result = Response.json({ sessions: filtered.slice(offset, offset + 1), next_cursor: offset + 1 < filtered.length ? 'session-cursor' : null });
    } else if (/^\/api\/sessions\/.+\/events$/.test(url.pathname)) {
      const next = url.searchParams.has('after');
      result = Response.json({ session: sessions[0], events: [{ id: next ? 'event-2' : 'event-1', event_id: next ? 'source-event-2' : 'source-event-1', payload_hash: (next ? 'b' : 'a').repeat(64), timestamp: '2026-10-04T00:00:01Z', action: next ? 'agent.message' : 'tool.invoked', payload: { synthetic: true, message: next ? 'Synthetic response' : adversarial } }], next_cursor: next ? null : 'event-cursor' });
    } else result = new Response('Not found', { status: 404 });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  let browser, context;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BEACON_CHROMIUM_EXECUTABLE });
    context = await browser.newContext({ httpCredentials: { username: 'beacon', password } });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    assert.equal((await fetch(baseUrl)).status, 401);
    await page.goto(baseUrl);
    await page.getByRole('button', { name: /合成專案.*合成 MBP/ }).waitFor();
    await page.getByRole('button', { name: '載入更多 session' }).click();
    await page.getByRole('button', { name: /合成專案.*合成 Mac mini/ }).waitFor();
    assert.equal(await page.locator('.session').count(), 2);
    await page.getByRole('button', { name: /合成專案.*合成 MBP/ }).click();
    await page.getByText('tool.invoked', { exact: true }).waitFor();
    await page.getByText('查看事件資料', { exact: true }).click();
    assert.equal(JSON.parse(await page.locator('.event pre').textContent()).message, adversarial);
    assert.equal(await page.locator('.event img, .event script').count(), 0);
    assert.equal(await page.evaluate(() => window.__beaconInjected), undefined);
    await page.getByRole('button', { name: '載入更多事件' }).click();
    await page.getByText('agent.message', { exact: true }).waitFor();
    assert.equal(await page.locator('.event').count(), 2);
    await page.getByLabel('Agent', { exact: true }).fill('codex_cli');
    await page.getByRole('button', { name: '套用篩選' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.session').length === 1 && document.querySelector('.session').textContent.includes('codex_cli'));
    assert.equal(await page.locator('.session').count(), 1);
    assert.equal(await page.locator('.event').count(), 0);
    await page.getByLabel('Agent', { exact: true }).fill('');
    await page.getByLabel('裝置', { exact: true }).selectOption('demo-mbp');
    await page.getByLabel('專案', { exact: true }).selectOption('demo-repo');
    await page.getByRole('button', { name: '套用篩選' }).click();
    await page.getByRole('button', { name: /合成專案.*合成 MBP/ }).waitFor();
    assert.equal(await page.locator('.session').count(), 1);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(pageErrors, []);
    deny = true;
    await page.getByRole('button', { name: '重新整理' }).click();
    await page.getByText('存取權限已失效。請重新載入頁面並登入。', { exact: true }).waitFor();
  } finally {
    await context?.close();
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

// UI workflow acceptance is synthetic. The real Worker/D1/R2 checks remain a separate layer.
test('manual project, task and context workflow requires ephemeral reviewer auth and preserves exact evidence', async () => {
  const reviewToken = 'synthetic-review-password-never-a-real-secret';
  const projectGroups = [], relations = [], tasks = [], contexts = [], writes = [], serverErrors = [];
  const linkedSessions = new Map();
  const source = { event_id: 'event-1', payload_hash: 'a'.repeat(64), session_id: sessions[0].id,
    device_id: sessions[0].device_id, timestamp: '2026-10-04T00:00:01Z' };
  const exactPayload = { synthetic: true, message: adversarial, version: 'referenced-original' };
  let scopeMismatch = false;
  const server = createServer(async (request, response) => {
    try {
      const write = request.method === 'POST';
      if (request.headers.authorization !== (write ? 'Bearer ' + reviewToken : authorization)) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Beacon synthetic workflow check"' });
        response.end(); return;
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      let result, body;
      if (write) {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString());
        writes.push({ path: url.pathname, body, authorization: request.headers.authorization });
        assert.equal(request.headers.cookie, undefined);
        assert.equal(request.url.includes(reviewToken), false);
      }
      if (url.pathname === '/') result = dashboardResponse();
      else if (url.pathname === '/dashboard.js') result = dashboardScriptResponse();
      else if (url.pathname === '/api/devices') result = Response.json({ devices: [ { id: 'demo-mbp', name: '合成 MBP' }, { id: 'demo-mini', name: '合成 Mac mini' } ] });
      else if (url.pathname === '/api/projects') result = Response.json({ projects: [{ id: 'demo-repo', name: '合成專案' }, { id: 'demo-api', name: '合成 API' }] });
      else if (url.pathname === '/api/sessions') result = Response.json({ sessions, next_cursor: null });
      else if (/^\/api\/sessions\/.+\/events$/.test(url.pathname)) result = Response.json({ session: sessions[0], events: [{ id: source.event_id, payload_hash: source.payload_hash, timestamp: source.timestamp, action: 'tool.invoked', versions: 2, payload: exactPayload }], next_cursor: null });
      else if (url.pathname === '/api/events/event-1') {
        assert.equal(url.searchParams.get('payload_hash'), source.payload_hash);
        result = Response.json({ event: { id: source.event_id, payload_hash: source.payload_hash, payload: exactPayload, scope_matches_index: !scopeMismatch } });
      } else if (url.pathname === '/api/project-groups') {
        if (write) { const group = { id: 'group-1', name: body.name, member_count: 0, members: [] }; projectGroups.push(group); result = Response.json({ project_group: group }, { status: 201 }); }
        else result = Response.json({ project_groups: projectGroups, next_cursor: null });
      } else if (url.pathname === '/api/project-groups/group-1') result = Response.json({ project_group: projectGroups[0], members: projectGroups[0].members, next_cursor: null });
      else if (url.pathname === '/api/project-groups/group-1/members' && write) {
        assert.deepEqual(body, { project_id: 'demo-repo' });
        projectGroups[0].members.push({ project_id: body.project_id, project_name: '合成專案', identity: 'https://github.com/synthetic/demo' }); projectGroups[0].member_count++;
        result = Response.json({ group_id: 'group-1', project_id: body.project_id, created: true }, { status: 201 });
      } else if (url.pathname === '/api/project-relations') {
        if (write) { const relation = { id: 'relation-1', ...body, from_project_name: '合成專案', to_project_name: '合成 API' }; relations.push(relation); result = Response.json({ relation, created: true }, { status: 201 }); }
        else result = Response.json({ relations, next_cursor: null });
      } else if (url.pathname === '/api/tasks') {
        if (write) { const task = { id: 'task-1', title: body.title, status: 'open', session_count: 0 }; tasks.push(task); result = Response.json({ task }, { status: 201 }); }
        else result = Response.json({ tasks, next_cursor: null });
      } else if (url.pathname === '/api/tasks/task-1') result = Response.json({ task: tasks[0], sessions: linkedSessions.get('task-1') || [], next_cursor: null });
      else if (url.pathname === '/api/tasks/task-1/sessions' && write) {
        assert.deepEqual(body, { session_id: sessions[0].id }); linkedSessions.set('task-1', [sessions[0]]); tasks[0].session_count = 1;
        result = Response.json({ task_id: 'task-1', session_id: sessions[0].id, created: true }, { status: 201 });
      } else if (url.pathname === '/api/tasks/task-1/status' && write) { tasks[0].status = body.status; result = Response.json({ task: tasks[0], changed: true }); }
      else if (url.pathname === '/api/context') {
        if (write) {
          assert.deepEqual(body.sources, [{ event_id: source.event_id, payload_hash: source.payload_hash }]);
          const context = { id: 'context-' + (contexts.length + 1), ...body, created_at: '2026-10-07T00:00:00Z', status: 'pending', authoritative: false, source_count: 1, sources: [source], audit: [{ action: 'created', created_at: '2026-10-07T00:00:00Z' }] };
          contexts.push(context); result = Response.json({ context }, { status: 201 });
        } else result = Response.json({ context: contexts.filter((entry) => entry.status === (url.searchParams.get('status') || 'approved')), next_cursor: null });
      } else if (/^\/api\/context\/context-\d+$/.test(url.pathname)) result = Response.json({ context: contexts.find((entry) => entry.id === url.pathname.split('/').at(-1)) });
      else if (/^\/api\/context\/context-\d+\/review$/.test(url.pathname) && write) {
        const context = contexts.find((entry) => entry.id === url.pathname.split('/').at(-2));
        context.status = body.decision === 'approve' ? 'approved' : 'rejected'; context.authoritative = body.decision === 'approve';
        if (context.supersedes_id && context.authoritative) { const prior = contexts.find((entry) => entry.id === context.supersedes_id); prior.status = 'superseded'; prior.authoritative = false; }
        context.audit.push({ action: body.decision, reason: body.reason, created_at: '2026-10-07T00:01:00Z' });
        result = Response.json({ context });
      } else result = new Response('Not found', { status: 404 });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { serverErrors.push(error); response.writeHead(500); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  let browser, context;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BEACON_CHROMIUM_EXECUTABLE });
    context = await browser.newContext({ httpCredentials: { username: 'beacon', password } });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseUrl);
    await page.getByRole('button', { name: /合成專案.*合成 MBP/ }).waitFor();
    await page.getByRole('tab', { name: '專案關聯', exact: true }).click();
    await page.locator('summary').filter({ hasText: '新增群組' }).click();
    await page.getByLabel('群組名稱', { exact: true }).fill('合成產品');
    await page.getByRole('button', { name: '新增群組', exact: true }).click();
    await page.getByText('請先在「管理與審閱權限」輸入審閱金鑰。', { exact: true }).waitFor();
    assert.equal(writes.length, 0);
    await page.getByLabel('審閱金鑰', { exact: true }).fill(reviewToken);
    await page.getByRole('button', { name: '新增群組', exact: true }).click();
    await page.getByRole('button', { name: /合成產品.*0 個專案/ }).waitFor();
    await page.getByLabel('加入專案', { exact: true }).selectOption('demo-repo');
    await page.getByRole('button', { name: '加入群組', exact: true }).click();
    await page.getByRole('button', { name: /合成產品.*1 個專案/ }).waitFor();
    await page.locator('summary').filter({ hasText: '新增關聯' }).click();
    await page.getByLabel('來源專案', { exact: true }).selectOption('demo-repo');
    await page.getByLabel('目標專案', { exact: true }).selectOption('demo-api');
    await page.getByRole('button', { name: '新增關聯', exact: true }).click();
    await page.getByText('合成專案 → 依賴 → 合成 API', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '交接與記憶', exact: true }).click();
    await page.locator('summary').filter({ hasText: '新增任務' }).click();
    await page.getByLabel('任務名稱', { exact: true }).fill('合成跨機驗證');
    await page.getByRole('button', { name: '新增任務', exact: true }).click();
    await page.getByRole('button', { name: /合成跨機驗證.*進行中/ }).waitFor();
    await page.getByRole('tab', { name: '活動紀錄', exact: true }).click();
    await page.getByRole('button', { name: /合成專案.*合成 MBP/ }).click();
    await page.getByLabel('將此 session 加入任務', { exact: true }).selectOption('task-1');
    await page.getByRole('button', { name: '加入任務', exact: true }).click();
    await page.getByText('此 session 已加入任務。', { exact: true }).waitFor();
    await page.getByLabel('作為筆記來源', { exact: true }).check();
    await page.getByRole('button', { name: '撰寫交接筆記', exact: true }).click();
    await page.locator('#task-detail').getByRole('button', { name: /合成專案.*合成 MBP/ }).waitFor();
    await page.getByLabel('筆記所屬任務（選填）', { exact: true }).selectOption('task-1');
    await page.getByLabel('筆記標題', { exact: true }).fill('合成修復結果');
    await page.getByLabel('筆記內容', { exact: true }).fill(adversarial);
    await page.getByRole('button', { name: '送交審閱', exact: true }).click();
    await page.getByText('筆記已送交審閱，目前尚未採用。', { exact: true }).waitFor();
    assert.equal(contexts[0].authoritative, false);
    assert.equal(contexts[0].status, 'pending');
    assert.equal(contexts[0].project_id, 'demo-repo');
    assert.equal(contexts[0].task_id, 'task-1');
    assert.equal(await page.locator('#context-detail .content').textContent(), adversarial);
    assert.equal(await page.locator('#context-detail img, #context-detail script').count(), 0);
    assert.equal(await page.evaluate(() => window.__beaconInjected), undefined);
    await page.getByText('原始來源（1）', { exact: true }).click();
    await page.getByText('查看此來源的原始版本', { exact: true }).click();
    await page.locator('#context-detail pre').waitFor();
    assert.deepEqual(JSON.parse(await page.locator('#context-detail pre').textContent()), exactPayload);
    await page.getByLabel('審閱說明（選填）', { exact: true }).fill('已比對合成原始事件');
    await page.getByRole('button', { name: '核准筆記', exact: true }).click();
    await page.getByText('筆記已人工核准。', { exact: true }).waitFor();
    assert.equal(contexts[0].authoritative, true);
    await page.getByRole('button', { name: '撰寫新版本', exact: true }).click();
    await page.getByLabel('筆記內容', { exact: true }).fill('合成修正版本，仍須重新審閱。');
    await page.getByRole('button', { name: '送交審閱', exact: true }).click();
    await page.getByText('筆記已送交審閱，目前尚未採用。', { exact: true }).waitFor();
    assert.equal(contexts[1].supersedes_id, contexts[0].id);
    assert.equal(contexts[0].status, 'approved');
    await page.getByRole('button', { name: '拒絕筆記', exact: true }).click();
    await page.getByText('筆記已拒絕。', { exact: true }).waitFor();
    assert.equal(contexts[1].status, 'rejected');
    assert.equal(contexts[0].status, 'approved');
    await page.getByLabel('審閱狀態', { exact: true }).selectOption('approved');
    await page.getByRole('button', { name: '查詢筆記', exact: true }).click();
    await page.locator('#context-list button').first().click();
    await page.getByRole('button', { name: '撰寫新版本', exact: true }).click();
    await page.getByLabel('筆記內容', { exact: true }).fill('合成最終核准版本。');
    await page.getByRole('button', { name: '送交審閱', exact: true }).click();
    await page.getByText('筆記已送交審閱，目前尚未採用。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '核准筆記', exact: true }).click();
    await page.getByText('筆記已人工核准。', { exact: true }).waitFor();
    assert.equal(contexts[0].status, 'superseded');
    assert.equal(contexts[2].status, 'approved');
    scopeMismatch = true;
    await page.getByText('原始來源（1）', { exact: true }).click();
    await page.getByText('查看此來源的原始版本', { exact: true }).click();
    await page.getByText('此來源版本的專案或 session 資訊與中央索引不一致，不能作為核准依據。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '撰寫新版本', exact: true }).click();
    const priorWrites = writes.length;
    await page.getByRole('button', { name: '送交審閱', exact: true }).click();
    await page.getByText('筆記包含範圍不一致的來源。請先移除，再重新選擇有效事件。', { exact: true }).waitFor();
    assert.equal(writes.length, priorWrites);
    assert.equal(writes.every((write) => write.authorization === 'Bearer ' + reviewToken && !JSON.stringify(write.body).includes(reviewToken)), true);
    assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
    assert.equal(await page.evaluate(() => document.cookie), '');
    await page.setViewportSize({ width: 375, height: 812 });
    for (const name of ['活動紀錄', '專案關聯', '交接與記憶']) {
      await page.getByRole('tab', { name, exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, name + ' fits mobile');
    }
    if (process.env.BEACON_DASHBOARD_UI_SCREENSHOT) await page.screenshot({ path: process.env.BEACON_DASHBOARD_UI_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: '清除金鑰', exact: true }).click();
    assert.equal(await page.getByLabel('審閱金鑰', { exact: true }).inputValue(), '');
    await page.getByLabel('審閱金鑰', { exact: true }).fill(reviewToken);
    await page.reload();
    await page.getByRole('button', { name: /合成專案.*合成 MBP/ }).waitFor();
    assert.equal(await page.getByLabel('審閱金鑰', { exact: true }).inputValue(), '');
    assert.deepEqual(errors, []);
    assert.deepEqual(serverErrors, []);
  } finally {
    await context?.close(); await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
