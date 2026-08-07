from __future__ import annotations

from arb_desktop.betslip.odds_only_calc import compute_odds_only_metrics, pick_best_bc_stake_usdt


def test_compute_odds_only_metrics_basic() -> None:
    calc = compute_odds_only_metrics(
        bti_odds=4.55,
        bc_odds=1.28,
        bti_stake_krw=10000,
        usdt_rate=1417.30,
        round_unit_krw=100,
        round_unit_usdt=0.1,
        target_profit_pct=4.0,
    )
    assert calc is not None
    assert calc.bti_stake_krw == 10000
    assert calc.bc_stake_usdt > 0
    assert calc.total_stake_krw > 0
    assert calc.current_profit_rate == min(calc.profit_rate_x10, calc.profit_rate_bc)


def test_pick_best_bc_stake_prefers_better_min_rate() -> None:
    stake = pick_best_bc_stake_usdt(
        bti_stake_krw=10000,
        bti_odds=4.55,
        bc_odds=1.28,
        usdt_rate=1417.30,
        round_unit_usdt=0.1,
    )
    assert float(stake) > 0
    assert round(float(stake) * 10) == float(stake) * 10


def test_compute_rejects_low_odds() -> None:
    assert compute_odds_only_metrics(
        bti_odds=1.0,
        bc_odds=2.0,
        bti_stake_krw=10000,
        usdt_rate=1400,
    ) is None
