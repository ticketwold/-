/** 2-leg 양방 마진 수익률 (%) */
export function calcProfitPercent(odds1: number, odds2: number): number | null {
  if (!odds1 || !odds2 || odds1 <= 1 || odds2 <= 1) return null;
  const margin = 1 / odds1 + 1 / odds2;
  if (margin >= 1) return null;
  return Math.round((1 / margin - 1) * 10000) / 100;
}

/** x10 KRW 베팅 → BC USDT 베팅 (테더 leg) */
export function calcLeg2Usdt(
  x10BetKrw: number,
  x10Odds: number,
  bcOdds: number,
  usdtKrwRate: number
): number {
  const r = usdtKrwRate > 0 ? usdtKrwRate : 1400;
  if (!x10BetKrw || !x10Odds || !bcOdds || bcOdds <= 1) return 0;
  return Math.round(((x10BetKrw * x10Odds) / (bcOdds * r)) * 100) / 100;
}

export function usdToKrw(usd: number, rate: number): number {
  return Math.round(usd * rate);
}

export function krwToUsd(krw: number, rate: number): number {
  return Math.round((krw / rate) * 100) / 100;
}

/** 순수익 KRW (x10 승리 시) */
export function netProfitIfX10Wins(
  x10BetKrw: number,
  x10Odds: number,
  bcUsdt: number,
  rate: number
): number {
  const x10Payout = x10BetKrw * x10Odds;
  const bcCostKrw = usdToKrw(bcUsdt, rate);
  return Math.round(x10Payout - x10BetKrw - bcCostKrw);
}

/** 순수익 KRW (BC 승리 시) */
export function netProfitIfBcWins(
  x10BetKrw: number,
  bcUsdt: number,
  bcOdds: number,
  rate: number
): number {
  const bcPayoutKrw = usdToKrw(bcUsdt * bcOdds, rate);
  return Math.round(bcPayoutKrw - x10BetKrw - usdToKrw(bcUsdt, rate));
}
