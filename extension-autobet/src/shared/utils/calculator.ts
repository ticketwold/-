/** 파싱 노이즈 — 이보다 작으면 동일 배당으로 간주 */
export const ODDS_NOISE_EPS = 0.008;

/** @deprecated use ODDS_NOISE_EPS */
export const ODDS_MIN_CHANGE = ODDS_NOISE_EPS;

export function calcArb(odds1: number, odds2: number): number | null {
  if (!odds1 || !odds2 || odds1 <= 1 || odds2 <= 1) return null;
  const margin = 1 / odds1 + 1 / odds2;
  if (margin >= 1) return null;
  return (1 / margin - 1) * 100;
}

export function calcProfit(btiOdds: number, polyOdds: number): number | null {
  if (!btiOdds || !polyOdds || btiOdds <= 1 || polyOdds <= 1) return null;
  const margin = 1 / btiOdds + 1 / polyOdds;
  return (1 / margin - 1) * 100;
}

export function polyPriceToDecimal(price: number | string): number | null {
  const p = parseFloat(String(price));
  if (!p || p <= 0 || p >= 1) return null;
  return 1 / p;
}

export function decimalToCents(decimal: number): number | null {
  if (!decimal || decimal <= 1) return null;
  return Math.round(1000 / decimal) / 10;
}

export function calcPolyBetUsd(
  btiBetKrw: number,
  btiOdds: number,
  polyOdds: number,
  rate?: number
): number {
  const r = rate || 1400;
  return Math.round(((btiBetKrw * btiOdds) / (polyOdds * r)) * 100) / 100;
}

export function calcBtiTotalPayoutKrw(btiBetKrw: number, btiOdds: number): number | null {
  if (!btiBetKrw || !btiOdds || btiOdds <= 1) return null;
  return Math.round(btiBetKrw * btiOdds);
}

export function calcPolyTotalPayoutUsd(polyStakeUsd: number, polyOdds: number): number | null {
  if (!polyStakeUsd || !polyOdds || polyOdds <= 1) return null;
  return Math.round(polyStakeUsd * polyOdds * 100) / 100;
}

export function calcPolyProfitUsd(polyStakeUsd: number, polyOdds: number): number | null {
  const total = calcPolyTotalPayoutUsd(polyStakeUsd, polyOdds);
  if (!total || !polyStakeUsd) return null;
  return Math.round((total - polyStakeUsd) * 100) / 100;
}

export function usdToKrw(usd: number, rate?: number): number | null {
  const r = rate || 1400;
  if (!usd || !r) return null;
  return Math.round(usd * r);
}

export function calcRoiPercent(stake: number, payout: number): number | null {
  if (!stake || !payout || stake <= 0) return null;
  return Math.round(((payout - stake) / stake) * 1000) / 10;
}

export function calcTotalInvestKrw(
  btiBetKrw: number,
  polyStakeUsd: number,
  rate?: number
): number | null {
  const polyStakeKrw = usdToKrw(polyStakeUsd, rate);
  if (!btiBetKrw || !polyStakeKrw) return null;
  return btiBetKrw + polyStakeKrw;
}

export function calcNetProfitIfBtiWins(
  btiBetKrw: number,
  btiOdds: number,
  polyStakeUsd: number,
  rate?: number
): number | null {
  const btiTotal = calcBtiTotalPayoutKrw(btiBetKrw, btiOdds);
  const polyStakeKrw = usdToKrw(polyStakeUsd, rate);
  if (!btiTotal || !btiBetKrw || polyStakeKrw == null) return null;
  return Math.round(btiTotal - btiBetKrw - polyStakeKrw);
}

export function calcNetProfitIfPolyWins(
  btiBetKrw: number,
  polyStakeUsd: number,
  polyOdds: number,
  rate?: number
): number | null {
  const polyPayout = calcPolyTotalPayoutUsd(polyStakeUsd, polyOdds);
  const polyTotalKrw = polyPayout != null ? usdToKrw(polyPayout, rate) : null;
  const polyStakeKrw = usdToKrw(polyStakeUsd, rate);
  if (!polyTotalKrw || !btiBetKrw || polyStakeKrw == null) return null;
  return Math.round(polyTotalKrw - polyStakeKrw - btiBetKrw);
}

export function calcNetRoiPercent(
  netProfitKrw: number | null,
  totalInvestKrw: number
): number | null {
  if (netProfitKrw == null || !totalInvestKrw || totalInvestKrw <= 0) return null;
  return Math.round((netProfitKrw / totalInvestKrw) * 1000) / 10;
}

export function formatKrwSigned(amount: number | null): string {
  if (amount == null || !Number.isFinite(amount)) return '-';
  const sign = amount >= 0 ? '+' : '';
  return `${sign}${amount.toLocaleString()}원`;
}

export function formatRoiPercent(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '-';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export function krwToUsd(krw: number, rate?: number): number | null {
  const r = rate || 1400;
  if (!krw || !r) return null;
  return Math.round((krw / r) * 100) / 100;
}

export function normalizeSportsOdds(o: number | string): number | null {
  const n = parseFloat(String(o));
  if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
  return Math.round(n * 1000) / 1000;
}

export function oddsDelta(a: number | string, b: number | string): number {
  return Math.abs((normalizeSportsOdds(a) || 0) - (normalizeSportsOdds(b) || 0));
}

export function oddsChangedSignificantly(
  prev: number | string,
  next: number | string,
  eps = ODDS_NOISE_EPS
): boolean {
  const n = normalizeSportsOdds(next);
  if (!n) return false;
  const p = normalizeSportsOdds(prev);
  if (!p) return true;
  return oddsDelta(p, n) >= eps;
}

export function stabilizeSportsOdds(
  prev: number | string,
  next: number | string,
  eps = ODDS_NOISE_EPS
): number | null {
  const n = normalizeSportsOdds(next);
  if (!n) return normalizeSportsOdds(prev);
  const p = normalizeSportsOdds(prev);
  if (!p) return n;
  return oddsDelta(p, n) < eps ? p : n;
}

export function resolveTotalPayout(stake: number, toWinDisplay: number): number | null {
  if (!stake || !toWinDisplay || toWinDisplay <= 0) return null;
  return toWinDisplay >= stake ? toWinDisplay : stake + toWinDisplay;
}

export function calcOddsFromStakeAndPayout(stake: number, toWinDisplay: number): number | null {
  const total = resolveTotalPayout(stake, toWinDisplay);
  if (!total || stake <= 0) return null;
  return total / stake;
}
