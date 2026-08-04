import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fixture = (name: string) =>
  readFileSync(resolve(__dirname, '../fixtures', name), 'utf8');

test('x10 slip fixture — betInformation odds', async ({ page }) => {
  await page.setContent(fixture('x10-slip.html'));
  const odds = await page.evaluate(() => {
    const card = document.querySelector('[class*="betInformation"]');
    const t = card?.textContent || '';
    const m = t.match(/@\s*(\d+\.\d{2})/);
    return m ? parseFloat(m[1]) : 0;
  });
  expect(odds).toBeCloseTo(1.16, 2);
});

test('bc slip fixture — bet__winner-coef', async ({ page }) => {
  await page.setContent(fixture('bc-slip.html'));
  const odds = await page.evaluate(() => {
    const el = document.querySelector('.bet__winner-coef');
    return el ? parseFloat(el.textContent || '0') : 0;
  });
  expect(odds).toBe(2);
});
