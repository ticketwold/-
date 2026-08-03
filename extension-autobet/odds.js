'use strict';

function calcArb(odds1, odds2) {
  if (!odds1 || !odds2 || odds1 <= 1 || odds2 <= 1) return null;
  const margin = (1 / odds1) + (1 / odds2);
  if (margin >= 1) return null;
  return ((1 / margin) - 1) * 100;
}

function calcProfit(btiOdds, polyOdds) {
  if (!btiOdds || !polyOdds || btiOdds <= 1 || polyOdds <= 1) return null;
  const margin = (1 / btiOdds) + (1 / polyOdds);
  return ((1 / margin) - 1) * 100;
}

function polyPriceToDecimal(price) {
  const p = parseFloat(price);
  if (!p || p <= 0 || p >= 1) return null;
  return 1 / p;
}

function decimalToCents(decimal) {
  if (!decimal || decimal <= 1) return null;
  return Math.round(1000 / decimal) / 10;
}

function calcPolyBetUsd(btiBetKrw, btiOdds, polyOdds, rate) {
  const r = rate || 1400;
  return Math.round(((btiBetKrw * btiOdds) / (polyOdds * r)) * 100) / 100;
}

function calcBtiTotalPayoutKrw(btiBetKrw, btiOdds) {
  if (!btiBetKrw || !btiOdds || btiOdds <= 1) return null;
  return Math.round(btiBetKrw * btiOdds);
}

function calcPolyTotalPayoutUsd(polyStakeUsd, polyOdds) {
  if (!polyStakeUsd || !polyOdds || polyOdds <= 1) return null;
  return Math.round(polyStakeUsd * polyOdds * 100) / 100;
}

function calcPolyProfitUsd(polyStakeUsd, polyOdds) {
  const total = calcPolyTotalPayoutUsd(polyStakeUsd, polyOdds);
  if (!total || !polyStakeUsd) return null;
  return Math.round((total - polyStakeUsd) * 100) / 100;
}

function usdToKrw(usd, rate) {
  const r = rate || 1400;
  if (!usd || !r) return null;
  return Math.round(usd * r);
}

function calcRoiPercent(stake, payout) {
  if (!stake || !payout || stake <= 0) return null;
  return Math.round(((payout - stake) / stake) * 1000) / 10;
}

function calcTotalInvestKrw(btiBetKrw, polyStakeUsd, rate) {
  const polyStakeKrw = usdToKrw(polyStakeUsd, rate);
  if (!btiBetKrw || !polyStakeKrw) return null;
  return btiBetKrw + polyStakeKrw;
}

function calcNetProfitIfBtiWins(btiBetKrw, btiOdds, polyStakeUsd, rate) {
  const btiTotal = calcBtiTotalPayoutKrw(btiBetKrw, btiOdds);
  const polyStakeKrw = usdToKrw(polyStakeUsd, rate);
  if (!btiTotal || !btiBetKrw || polyStakeKrw == null) return null;
  return Math.round(btiTotal - btiBetKrw - polyStakeKrw);
}

function calcNetProfitIfPolyWins(btiBetKrw, polyStakeUsd, polyOdds, rate) {
  const polyTotalKrw = usdToKrw(calcPolyTotalPayoutUsd(polyStakeUsd, polyOdds), rate);
  const polyStakeKrw = usdToKrw(polyStakeUsd, rate);
  if (!polyTotalKrw || !btiBetKrw || polyStakeKrw == null) return null;
  return Math.round(polyTotalKrw - polyStakeKrw - btiBetKrw);
}

function calcNetRoiPercent(netProfitKrw, totalInvestKrw) {
  if (netProfitKrw == null || !totalInvestKrw || totalInvestKrw <= 0) return null;
  return Math.round((netProfitKrw / totalInvestKrw) * 1000) / 10;
}

function formatKrwSigned(amount) {
  if (amount == null || !Number.isFinite(amount)) return '-';
  const sign = amount >= 0 ? '+' : '';
  return `${sign}${amount.toLocaleString()}원`;
}

function formatRoiPercent(pct) {
  if (pct == null || !Number.isFinite(pct)) return '-';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function krwToUsd(krw, rate) {
  const r = rate || 1400;
  if (!krw || !r) return null;
  return Math.round((krw / r) * 100) / 100;
}

/** 파싱 노이즈 — 이보다 작으면 동일 배당으로 간주 */
const ODDS_NOISE_EPS = 0.008;

function normalizeSportsOdds(o) {
  const n = parseFloat(o);
  if (!Number.isFinite(n) || n <= 1.01 || n >= 100) return null;
  return Math.round(n * 1000) / 1000;
}

function oddsDelta(a, b) {
  return Math.abs((normalizeSportsOdds(a) || 0) - (normalizeSportsOdds(b) || 0));
}

function oddsChangedSignificantly(prev, next, eps = ODDS_NOISE_EPS) {
  const n = normalizeSportsOdds(next);
  if (!n) return false;
  const p = normalizeSportsOdds(prev);
  if (!p) return true;
  return oddsDelta(p, n) >= eps;
}

function stabilizeSportsOdds(prev, next, eps = ODDS_NOISE_EPS) {
  const n = normalizeSportsOdds(next);
  if (!n) return normalizeSportsOdds(prev);
  const p = normalizeSportsOdds(prev);
  if (!p) return n;
  return oddsDelta(p, n) < eps ? p : n;
}

/** @deprecated use ODDS_NOISE_EPS */
const ODDS_MIN_CHANGE = ODDS_NOISE_EPS;

function resolveTotalPayout(stake, toWinDisplay) {
  if (!stake || !toWinDisplay || toWinDisplay <= 0) return null;
  return toWinDisplay >= stake ? toWinDisplay : stake + toWinDisplay;
}

function calcOddsFromStakeAndPayout(stake, toWinDisplay) {
  const total = resolveTotalPayout(stake, toWinDisplay);
  if (!total || stake <= 0) return null;
  return total / stake;
}
