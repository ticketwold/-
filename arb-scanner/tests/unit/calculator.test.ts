import { describe, expect, it } from 'vitest';
import {
  calcLeg2Usdt,
  calcProfitPercent,
  netProfitIfBcWins,
  netProfitIfX10Wins,
} from '../../src/core/calculator';

describe('calculator', () => {
  it('returns profit percent for viable arb', () => {
    expect(calcProfitPercent(2.2, 2.2)).toBeGreaterThan(0);
    expect(calcProfitPercent(1.5, 1.5)).toBeNull();
  });

  it('calculates BC USDT leg from x10 KRW', () => {
    const usdt = calcLeg2Usdt(100_000, 2.0, 2.1, 1400);
    expect(usdt).toBeCloseTo(68.03, 1);
  });

  it('estimates net profit both outcomes', () => {
    const x10 = netProfitIfX10Wins(100_000, 2.0, 68, 1400);
    const bc = netProfitIfBcWins(100_000, 68, 2.1, 1400);
    expect(x10).toBeGreaterThan(0);
    expect(bc).toBeGreaterThan(0);
  });
});
