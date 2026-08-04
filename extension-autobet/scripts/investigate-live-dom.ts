import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), 'live-dom-reports');
const diagJs = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'browser-diag.js'), 'utf8');

async function investigateSite(name: string, url: string, waitMs = 15000) {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  let navError = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(waitMs);
  } catch (e) {
    navError = String(e);
  }

  const mainReport = await page.evaluate(
    ({ code, lbl }) => {
      eval(code);
      return browserDiag(lbl);
    },
    { code: diagJs, lbl: name + '-top' }
  );

  const frameReports = [];
  for (const frame of page.frames()) {
    try {
      frameReports.push(
        await frame.evaluate(
          ({ code, lbl }) => {
            eval(code);
            return browserDiag(lbl);
          },
          { code: diagJs, lbl: name + '-frame' }
        )
      );
    } catch (e) {
      frameReports.push({ href: frame.url(), error: String(e), crossOrigin: true });
    }
  }

  mkdirSync(outDir, { recursive: true });
  try {
    await page.screenshot({ path: resolve(outDir, name + '.png') });
  } catch (_) {}

  const result = {
    site: name,
    url,
    finalUrl: page.url(),
    title: await page.title(),
    navError,
    mainReport,
    frameReports,
    frameCount: frameReports.length,
  };
  writeFileSync(resolve(outDir, name + '.json'), JSON.stringify(result, null, 2));
  await browser.close();
  return result;
}

function summarize(result) {
  const all = [result.mainReport, ...(result.frameReports || [])].filter(Boolean);
  return {
    finalUrl: result.finalUrl,
    title: result.title,
    navError: result.navError,
    frameCount: result.frameCount,
    winnerCoefTotal: all.reduce((s, f) => s + (f.winnerCoefCount || 0), 0),
    counterTotal: all.reduce((s, f) => s + (f.counterInput || []).length, 0),
    betslipIframes: all.flatMap((f) => (f.iframes || []).filter((i) => i.isBetslip)),
    oddsElements: all.flatMap((f) => f.oddsElements || []).slice(0, 30),
    shadowHosts: all.flatMap((f) => f.shadowHosts || []).slice(0, 20),
    scannerFailures: [...new Set(all.flatMap((f) => f.scannerWouldFail || []))],
    slipFrames: all
      .filter((f) => f.winnerCoefCount > 0 || (f.counterInput || []).length > 0 || (f.slipMarkers || []).length > 0)
      .map((f) => ({
        href: (f.href || '').slice(0, 160),
        winnerCoef: f.winnerCoefCount,
        winnerCoefEls: f.winnerCoef,
        counter: (f.counterInput || []).length,
        fails: f.scannerWouldFail,
        preview: (f.bodyPreview || '').slice(0, 500),
      })),
    allIframeChildOdds: all.flatMap((f) =>
      (f.iframes || []).filter((i) => i.accessible && i.childOdds && i.childOdds.length).map((i) => ({
        src: i.src,
        childOdds: i.childOdds,
        childBodyPreview: (i.childBodyPreview || '').slice(0, 600),
      }))
    ),
  };
}

const bc = await investigateSite('bcgame', 'https://bc.game/sports');
const x10 = await investigateSite('x10x10s', 'https://www.x10x10s.com/');
const x10ip = await investigateSite('x10x10s-inplay', 'https://www.x10x10s.com/in-play/1');

const summary = { ts: new Date().toISOString(), bcgame: summarize(bc), x10x10s: summarize(x10), x10inplay: summarize(x10ip) };
writeFileSync(resolve(outDir, 'SUMMARY.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
