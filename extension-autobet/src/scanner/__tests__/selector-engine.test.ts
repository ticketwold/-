import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  findBcWinnerCoefElements,
  findX10SlipCards,
  readOddsFromElement,
} from '../selector-engine';

function loadFixture(name: string): void {
  const html = readFileSync(resolve(__dirname, `../../../tests/fixtures/${name}`), 'utf8');
  document.documentElement.innerHTML = html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
}

describe('selector-engine — BC bet__winner-coef', () => {
  beforeEach(() => loadFixture('bc-betslip.html'));

  it('reads active coef 2.00, ignores suspended', () => {
    const els = findBcWinnerCoefElements(document.body);
    expect(els.length).toBe(1);
    expect(els[0]?.textContent?.trim()).toBe('2.00');
    expect(readOddsFromElement(els[0]!)).toBe(2);
  });

  it('does not read board 12.10 from slip scan', () => {
    const els = findBcWinnerCoefElements(document.body);
    const odds = els.map((e) => readOddsFromElement(e)).filter(Boolean);
    expect(odds).not.toContain(12.1);
    expect(odds).toEqual([2]);
  });
});

describe('selector-engine — x10 slip vs board', () => {
  beforeEach(() => loadFixture('x10-betslip.html'));

  it('finds slip card with @ 1.16 not board 11.50', () => {
    const cards = findX10SlipCards(document.body);
    expect(cards.length).toBeGreaterThan(0);
    const slipOdds = cards.map((c) => readOddsFromElement(c)).filter(Boolean);
    expect(slipOdds.some((o) => Math.abs(o! - 1.16) < 0.01)).toBe(true);
    expect(slipOdds.some((o) => Math.abs(o! - 11.5) < 0.01)).toBe(false);
  });
});
