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
    else if (url.pathname === '/api/sessions') {
      const filtered = sessions.filter((session) =>
        (!url.searchParams.get('device_id') || session.device_id === url.searchParams.get('device_id')) &&
        (!url.searchParams.get('project_id') || session.project_id === url.searchParams.get('project_id')) &&
        (!url.searchParams.get('harness') || session.harness === url.searchParams.get('harness')));
      const offset = url.searchParams.has('before') ? 1 : 0;
      result = Response.json({ sessions: filtered.slice(offset, offset + 1), next_cursor: offset + 1 < filtered.length ? 'session-cursor' : null });
    } else if (/^\/api\/sessions\/.+\/events$/.test(url.pathname)) {
      const next = url.searchParams.has('after');
      result = Response.json({ session: sessions[0], events: [{ id: next ? 'event-2' : 'event-1', event_id: next ? 'source-event-2' : 'source-event-1', timestamp: '2026-10-04T00:00:01Z', action: next ? 'agent.message' : 'tool.invoked', payload: { synthetic: true, message: next ? 'Synthetic response' : adversarial } }], next_cursor: next ? null : 'event-cursor' });
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
