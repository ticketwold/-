import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ScannerEngine } from '../scanner-engine';
import type { OddsPayload } from '../types';

function loadFixture(name: string): void {
  const html = readFileSync(resolve(__dirname, `../../../tests/fixtures/${name}`), 'utf8');
  document.documentElement.innerHTML = html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => queueMicrotask(() => r()));
}

describe('ScannerEngine — x10 slip odds', () => {
  let emissions: OddsPayload[];
  let stop: () => void;

  beforeEach(() => {
    loadFixture('x10-betslip.html');
    Object.defineProperty(window, 'location', {
      value: { href: 'https://www.x10x10s.com/api/sportscenter/betslip' },
      writable: true,
    });
    emissions = [];
    const engine = new ScannerEngine({
      siteId: 'x10',
      bootstrapSource: 'bti',
      onOddsChange: (slip) => {
        if (slip) emissions.push(slip);
      },
    });
    stop = engine.start();
  });

  afterEach(() => stop());

  it('reads slip @ 1.16 matching screen', async () => {
    await flushMicrotasks();
    const engine = new ScannerEngine({
      siteId: 'x10',
      bootstrapSource: 'bti',
      onOddsChange: () => {},
    });
    engine.start();
    const odds = engine.readOdds();
    expect(odds?.odds).toBeCloseTo(1.16, 2);
    expect(odds?.fromSlip).toBe(true);
    engine.start(); // noop duplicate
  });

  it('emits on DOM odds change (MO)', async () => {
    await flushMicrotasks();
    const oddsEl = document.querySelector('.betInformation__odds')!;
    oddsEl.textContent = '@ 1.22';
    oddsEl.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 50));

    const last = emissions.at(-1);
    expect(last?.odds).toBeCloseTo(1.22, 2);
  });

  it('clears on bet removal', async () => {
    await flushMicrotasks();
    document.querySelector('.betslip_fe_BetSecondary_bet')?.remove();
    document.querySelector('#counter')?.remove();
    document.body.dispatchEvent(new Event('click', { bubbles: true }));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 50));
    // may emit null — engine should not emit board 11.50
    const bad = emissions.filter((e) => Math.abs(e.odds - 11.5) < 0.1);
    expect(bad.length).toBe(0);
  });
});

describe('ScannerEngine — BC bet__winner-coef', () => {
  beforeEach(() => {
    loadFixture('bc-betslip.html');
    Object.defineProperty(window, 'location', {
      value: { href: 'https://bc.game/sports' },
      writable: true,
    });
  });

  it('reads 2.00 not suspended or board', () => {
    const engine = new ScannerEngine({
      siteId: 'bcgame',
      bootstrapSource: 'bcgame',
      onOddsChange: () => {},
    });
    engine.start();
    const odds = engine.readOdds();
    expect(odds?.odds).toBe(2);
    expect(odds?.source).toContain('winner-coef');
  });

  it('10 sequential odds changes', async () => {
    const seq = [1.85, 1.9, 1.95, 2.0, 2.05, 2.1, 1.88, 1.92, 2.15, 2.2];
    const read: number[] = [];
    const engine = new ScannerEngine({
      siteId: 'bcgame',
      bootstrapSource: 'bcgame',
      onOddsChange: (slip) => {
        if (slip?.odds) read.push(slip.odds);
      },
    });
    engine.start();
    const el = document.getElementById('coef-active')!;

    for (const v of seq) {
      el.textContent = v.toFixed(2);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 20));
      const snap = engine.readOdds();
      expect(snap?.odds).toBeCloseTo(v, 2);
    }
    expect(read.length).toBeGreaterThanOrEqual(8);
  });
});

describe('ScannerEngine — never emits invalid odds', () => {
  it('suspended coef change does not emit numeric odds', async () => {
    loadFixture('bc-betslip.html');
    Object.defineProperty(window, 'location', {
      value: { href: 'https://bc.game/' },
      writable: true,
    });
    const emissions: OddsPayload[] = [];
    const engine = new ScannerEngine({
      siteId: 'bcgame',
      bootstrapSource: 'bcgame',
      onOddsChange: (slip) => {
        if (slip) emissions.push(slip);
      },
    });
    engine.start();
    const active = document.getElementById('coef-active')!;
    active.className = 'bet__winner-coef bet__winner-coefSuspended';
    active.textContent = '정지된';
    active.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 50));

    const afterSuspend = engine.readOdds();
    expect(afterSuspend).toBeNull();
    expect(emissions.every((e) => Number.isFinite(e.odds) && e.odds > 1.01)).toBe(true);
  });
});

describe('ScannerEngine — iframe late mount', () => {
  it('detects slip after iframe content loads', async () => {
    document.body.innerHTML = '<div id="shell"></div>';
    Object.defineProperty(window, 'location', {
      value: { href: 'https://www.x10x10s.com/in-play/match/1' },
      writable: true,
    });

    const engine = new ScannerEngine({
      siteId: 'x10',
      bootstrapSource: 'bti',
      onOddsChange: () => {},
    });
    engine.start();

    const slipHtml = readFileSync(resolve(__dirname, '../../../tests/fixtures/x10-betslip.html'), 'utf8');
    const iframe = document.createElement('iframe');
    iframe.srcdoc = slipHtml;
    document.body.appendChild(iframe);

    await new Promise((r) => setTimeout(r, 100));
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 80));

    const odds = engine.readOdds();
    expect(odds?.odds).toBeCloseTo(1.16, 2);
  });
});
