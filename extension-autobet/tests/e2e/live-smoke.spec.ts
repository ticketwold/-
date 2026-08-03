import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const report: Record<string, unknown> = {
  timestamp: new Date().toISOString(),
  liveSites: {},
};

test.describe('Live site smoke (no login — slip DOM not expected)', () => {
  test('x10x10s.com loads', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    let status = 0;
    try {
      const res = await page.goto('https://www.x10x10s.com/', { timeout: 25000, waitUntil: 'domcontentloaded' });
      status = res?.status() ?? 0;
    } catch (e) {
      report.liveSites = {
        ...report.liveSites as object,
        x10x10s: { ok: false, error: String(e), logs: logs.slice(0, 20) },
      };
      writeFileSync(resolve('tests/e2e/live-smoke-report.json'), JSON.stringify(report, null, 2));
      return;
    }
    const title = await page.title();
    report.liveSites = {
      ...(report.liveSites as object),
      x10x10s: {
        ok: status < 400,
        status,
        title,
        url: page.url(),
        hasBetslipIframe: (await page.locator('iframe[src*="betslip"], iframe[src*="sportscenter"]').count()) > 0,
        note: 'Bet slip odds require login + in-play selection — not verified live',
        logs: logs.filter((l) => l.includes('Scanner') || l.includes('slip')).slice(0, 10),
      },
    };
    writeFileSync(resolve('tests/e2e/live-smoke-report.json'), JSON.stringify(report, null, 2));
  });

  test('bc.game loads', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    let status = 0;
    try {
      const res = await page.goto('https://bc.game/sports', { timeout: 25000, waitUntil: 'domcontentloaded' });
      status = res?.status() ?? 0;
    } catch (e) {
      report.liveSites = {
        ...report.liveSites as object,
        bcgame: { ok: false, error: String(e), logs: logs.slice(0, 20) },
      };
      writeFileSync(resolve('tests/e2e/live-smoke-report.json'), JSON.stringify(report, null, 2));
      return;
    }
    const coefCount = await page.locator('.bet__winner-coef, [class*="bet__winner-coef"]').count();
    report.liveSites = {
      ...(report.liveSites as object),
      bcgame: {
        ok: status < 400,
        status,
        title: await page.title(),
        url: page.url(),
        betWinnerCoefInDom: coefCount,
        note: 'Bet slip odds require login + selection — extension content script not injected in this smoke test',
        logs: logs.slice(0, 10),
      },
    };
    writeFileSync(resolve('tests/e2e/live-smoke-report.json'), JSON.stringify(report, null, 2));
  });
});
