import { describe, expect, it } from 'vitest';
import {
  calcArbitrageProfit,
  matchKeyFromEvent,
  teamsMatch,
  findMatchingQuotes,
} from '../../src/core/matcher';
import type { OddsQuote } from '../../src/core/types';

const mk = (site: 'x10' | 'bcgame', event: string, odds: number): OddsQuote => ({
  id: `${site}-${odds}`,
  siteId: site,
  eventName: event,
  selection: 'W1',
  odds,
  source: 'slip',
  frameUrl: 'https://test',
  frameDepth: 0,
  inShadowDom: false,
  confidence: 1,
  timestamp: Date.now(),
});

describe('matcher', () => {
  it('normalizes event keys', () => {
    expect(matchKeyFromEvent('Team A vs Team B')).toBe('team a|team b');
  });

  it('matches teams loosely', () => {
    expect(teamsMatch('Team Alpha', 'Alpha')).toBe(true);
  });

  it('finds cross-site pairs', () => {
    const x10 = [mk('x10', 'Alpha vs Beta', 2.1)];
    const bc = [mk('bcgame', 'Alpha vs Beta', 2.05)];
    expect(findMatchingQuotes(x10, bc)).toHaveLength(1);
  });

  it('calculates arbitrage profit', () => {
    const profit = calcArbitrageProfit(2.2, 2.2);
    expect(profit).toBeGreaterThan(0);
    expect(calcArbitrageProfit(1.5, 1.5)).toBeLessThan(0);
  });
});
