import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// These callbacks execute in Chromium; keep DOM globals out of the Worker's type environment.
declare const document: {
  querySelectorAll(selector: string): { length: number };
  querySelector(selector: string): { textContent: string | null } | null;
  documentElement: { scrollWidth: number };
};
declare const window: { innerWidth: number };

/** Optional browser check through the real workerd router, D1 and R2. */
export async function verifyWorkerDashboard(dispatchFetch: typeof fetch, readToken: string) {
  const { chromium } = await import(process.env.BEACON_PLAYWRIGHT_MODULE || 'playwright');
  const server = createServer(async (request, response) => {
    try {
      const result = await dispatchFetch('http://localhost' + request.url, {
        method: request.method,
        headers: Object.fromEntries(Object.entries(request.headers).filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value!])),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(503); response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser test server unavailable');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  let browser, context;
  try {
    assert.equal((await fetch(baseUrl + '/dashboard')).status, 401);
    browser = await chromium.launch({ headless: true, executablePath: process.env.BEACON_CHROMIUM_EXECUTABLE });
    context = await browser.newContext({ httpCredentials: { username: 'beacon', password: readToken } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(baseUrl + '/dashboard');
    await page.waitForFunction(() => document.querySelectorAll('.session').length >= 2);
    const sessionCount = await page.locator('.session').count();
    await page.getByRole('button', { name: /Synthetic MBP/ }).first().click();
    await page.locator('.event').first().waitFor();
    await page.locator('.event summary').first().click();
    const payload = JSON.parse(await page.locator('.event pre').first().textContent());
    assert.equal(payload.vendor, 'beacon');
    assert.equal(payload.message, 'synthetic only');
    const eventCount = await page.locator('.event').count();
    await page.getByLabel('裝置', { exact: true }).selectOption('mini');
    await page.getByLabel('Agent', { exact: true }).fill('codex_cli');
    await page.getByRole('button', { name: '套用篩選' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.session').length === 1 && document.querySelector('.session')!.textContent!.includes('Synthetic Mac mini'));
    assert.equal(await page.locator('.event').count(), 0);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
    if (process.env.BEACON_DASHBOARD_SCREENSHOT) await page.screenshot({ path: process.env.BEACON_DASHBOARD_SCREENSHOT, fullPage: true });
    return { sessionCount, eventCount, mobileWidth: 375, anonymousStatus: 401 };
  } finally {
    await context?.close(); await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
