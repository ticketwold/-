import { computeOddsOnlyMetrics, pickBestBcStakeUsdt, oddsInRange } from "./profit_engine.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const stake = pickBestBcStakeUsdt({
  btiStakeKrw: 10000,
  btiOdds: 2.13,
  bcOdds: 1.92,
  usdtRate: 1400,
  roundUnitUsdt: 0.1,
});
assert(stake > 0, "stake should be positive");

const m = computeOddsOnlyMetrics({
  btiOdds: 2.13,
  bcOdds: 1.92,
  btiStakeKrw: 10000,
  usdtRate: 1400,
  targetProfitPct: 0.5,
});
assert(m != null, "metrics");
assert(oddsInRange(2.1), "odds in range");
assert(!oddsInRange(0.5), "odds out of range");

console.log("profit_engine tests: PASS", { stake, rate: m.current_profit_rate });
