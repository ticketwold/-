import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = resolve(root, 'tests/fixtures');

function fixtureServer() {
  const bundle = readFileSync(resolve(root, 'tests/e2e/harness-bundle.mjs'), 'utf8');
  return createServer((req, res) => {
    if (req.url === '/harness-bundle.mjs') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundle);
      return;
    }
    const name = req.url === '/bc' ? 'bc-betslip.html' : 'x10-betslip.html';
    let html = readFileSync(resolve(fixtures, name), 'utf8');
    html = html.replace('</body>', '<script type="module" src="/harness-bundle.mjs"></script></body>');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
}

const BC_ODDS_SEQ = [1.85, 1.9, 1.95, 2.0, 2.05, 2.1, 1.88, 1.92, 2.15, 2.2, 1.75, 2.3];
const X10_ODDS_SEQ = [1.12, 1.14, 1.16, 1.18, 1.2, 1.22, 1.15, 1.17, 1.19, 1.21, 1.13, 1.23];

test.describe('Real Chrome — BC.Game slip fixture (12 odds changes)', () => {
  let server: ReturnType<typeof fixtureServer>;
  let port: number;

  test.beforeAll(async () => {
    server = fixtureServer();
    await new Promise<void>((r) => server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      r();
    }));
  });

  test.afterAll(() => server.close());

  test('12 sequential BC coef updates match screen', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/bc`);
    await page.waitForFunction(() => (window as unknown as { __h?: unknown }).__h != null);

    const results: { expected: number; actual: number | null }[] = [];

    for (const expected of BC_ODDS_SEQ) {
      await page.locator('#coef-active').evaluate((el, v) => {
        el.textContent = Number(v).toFixed(2);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, expected);
      await page.waitForTimeout(40);
      const actual = await page.evaluate(() => {
        const h = (window as unknown as { __h?: { read: () => { odds: number } | null } }).__h;
        return h?.read()?.odds ?? null;
      });
      results.push({ expected, actual });
    }

    await page.evaluate(() => {
      (window as unknown as { __h?: { stop: () => void } }).__h?.stop();
    });

    const mismatches = results.filter((r) => r.actual == null || Math.abs(r.actual - r.expected) > 0.01);
    console.log('[BC E2E]', JSON.stringify(results));
    expect(mismatches.length).toBe(0);
  });
});

test.describe('Real Chrome — x10 slip fixture (12 odds changes)', () => {
  let server: ReturnType<typeof fixtureServer>;
  let port: number;

  test.beforeAll(async () => {
    server = fixtureServer();
    await new Promise<void>((r) => server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      r();
    }));
  });

  test.afterAll(() => server.close());

  test('12 sequential @ odds updates match screen, not board 11.50', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/x10`);
    await page.waitForFunction(() => (window as unknown as { __h?: unknown }).__h != null);

    const results: { expected: number; actual: number | null }[] = [];

    for (const expected of X10_ODDS_SEQ) {
      await page.locator('.betInformation__odds').evaluate((el, v) => {
        el.textContent = `@ ${Number(v).toFixed(2)}`;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, expected);
      await page.waitForTimeout(40);
      const actual = await page.evaluate(() => {
        return (window as unknown as { __h?: { read: () => { odds: number } | null } }).__h?.read()?.odds ?? null;
      });
      results.push({ expected, actual });
    }

    const boardLeak = results.some((r) => r.actual != null && Math.abs(r.actual - 11.5) < 0.05);
    console.log('[x10 E2E]', JSON.stringify(results));
    expect(boardLeak).toBe(false);
    expect(results.every((r) => r.actual != null && Math.abs(r.actual! - r.expected) < 0.02)).toBe(true);
  });
});

test.describe('Suspended coef never becomes engine odds', () => {
  test('정지된 text blocked in real browser', async ({ page }) => {
    let html = readFileSync(resolve(fixtures, 'bc-betslip.html'), 'utf8');
    html = html.replace('</body>', '<script type="module" src="/harness-bundle.mjs"></script></body>');
    const server = fixtureServer();
    const port = await new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port)));
    await page.goto(`http://127.0.0.1:${port}/bc`);
    await page.waitForFunction(() => (window as unknown as { __h?: unknown }).__h != null);

    await page.locator('#coef-active').evaluate((el) => {
      el.className = 'bet__winner-coef bet__winner-coefSuspended';
      el.textContent = '정지된';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(60);
    const actual = await page.evaluate(() => (window as unknown as { __h?: { read: () => unknown } }).__h?.read() ?? null);
    server.close();
    expect(actual).toBeNull();
  });
});
