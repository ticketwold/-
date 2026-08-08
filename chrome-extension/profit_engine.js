/** Decimal-equivalent profit / stake math (scaled integers). */

export const ODDS_MIN = 1.01;
export const ODDS_MAX = 100;

function toScaled(value, scale) {
  return Math.round(Number(value) * scale);
}

function fromScaled(value, scale) {
  return value / scale;
}

function roundKrw(value, unit) {
  if (unit <= 0) return Math.round(value);
  return Math.round(value / unit) * unit;
}

function usdtCandidates(raw, unit) {
  if (unit <= 0) return [Math.round(raw * 100) / 100];
  const steps = raw / unit;
  const floorStep = Math.floor(steps);
  const ceilStep = Math.ceil(steps);
  const nearestStep = Math.round(steps);
  const seen = new Set();
  for (const step of [floorStep - 1, floorStep, nearestStep, ceilStep, ceilStep + 1]) {
    if (step < 0) continue;
    const val = Math.round(step * unit * 10) / 10;
    seen.add(val);
  }
  return [...seen].sort((a, b) => a - b);
}

function profitMetrics(btiStakeKrw, btiOdds, bcOdds, bcStakeUsdt, usdtRate) {
  const bcStakeKrw = bcStakeUsdt * usdtRate;
  const totalStake = btiStakeKrw + bcStakeKrw;
  if (totalStake <= 0) {
    return { profitX10: 0, profitBc: 0, rateX10: 0, rateBc: 0, minProfit: 0, currentRate: 0 };
  }
  const profitX10 = btiStakeKrw * btiOdds - totalStake;
  const profitBc = bcStakeUsdt * bcOdds * usdtRate - totalStake;
  const rateX10 = (profitX10 / totalStake) * 100;
  const rateBc = (profitBc / totalStake) * 100;
  const minProfit = Math.min(profitX10, profitBc);
  const currentRate = Math.min(rateX10, rateBc);
  return { profitX10, profitBc, rateX10, rateBc, minProfit, currentRate };
}

export function pickBestBcStakeUsdt({ btiStakeKrw, btiOdds, bcOdds, usdtRate, roundUnitUsdt = 0.1 }) {
  const x = Number(btiStakeKrw);
  const a = Number(btiOdds);
  const b = Number(bcOdds);
  const r = Number(usdtRate);
  const unit = Number(roundUnitUsdt);
  if (b <= 0 || r <= 0) return 0;
  const raw = (x * a) / b / r;
  let bestStake = 0;
  let bestRate = -999999;
  for (const candidate of usdtCandidates(raw, unit)) {
    const { currentRate } = profitMetrics(x, a, b, candidate, r);
    if (currentRate > bestRate) {
      bestRate = currentRate;
      bestStake = candidate;
    }
  }
  return bestStake;
}

export function oddsInRange(odds) {
  if (odds == null) return false;
  const val = Number(odds);
  return Number.isFinite(val) && val >= ODDS_MIN && val <= ODDS_MAX;
}

/**
 * @returns {object|null}
 */
export function computeOddsOnlyMetrics({
  btiOdds,
  bcOdds,
  btiStakeKrw,
  usdtRate,
  roundUnitKrw = 100,
  roundUnitUsdt = 0.1,
  targetProfitPct = 0,
}) {
  const a = Number(btiOdds);
  const b = Number(bcOdds);
  const r = Number(usdtRate);
  if (!oddsInRange(a) || !oddsInRange(b) || r <= 0) return null;

  const x = roundKrw(Number(btiStakeKrw), roundUnitKrw);
  const y = pickBestBcStakeUsdt({
    btiStakeKrw: x,
    btiOdds: a,
    bcOdds: b,
    usdtRate: r,
    roundUnitUsdt,
  });
  const { profitX10, profitBc, rateX10, rateBc, minProfit, currentRate } = profitMetrics(x, a, b, y, r);
  const bcStakeKrw = y * r;
  const total = x + bcStakeKrw;
  return {
    bti_odds: a,
    bc_odds: b,
    bti_stake_krw: x,
    bc_stake_usdt: y,
    bc_stake_krw: bcStakeKrw,
    total_stake_krw: total,
    profit_x10_krw: profitX10,
    profit_bc_krw: profitBc,
    profit_rate_x10: rateX10,
    profit_rate_bc: rateBc,
    min_profit_krw: minProfit,
    current_profit_rate: currentRate,
    target_profit_pct: Number(targetProfitPct),
    target_delta_pct: currentRate - Number(targetProfitPct),
  };
}
