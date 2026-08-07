from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP, Decimal


ODDS_MIN = Decimal("1.01")
ODDS_MAX = Decimal("100")


@dataclass(frozen=True)
class OddsOnlyMetrics:
    bti_odds: float
    bc_odds: float
    bti_stake_krw: float
    bc_stake_usdt: float
    bc_stake_krw: float
    total_stake_krw: float
    profit_x10_krw: float
    profit_bc_krw: float
    profit_rate_x10: float
    profit_rate_bc: float
    min_profit_krw: float
    current_profit_rate: float
    target_profit_pct: float
    target_delta_pct: float


def _d(value: float | int | str | Decimal) -> Decimal:
    return Decimal(str(value))


def _round_krw(value: Decimal, unit: int) -> Decimal:
    if unit <= 0:
        return value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    step = _d(unit)
    return (value / step).quantize(Decimal("1"), rounding=ROUND_HALF_UP) * step


def _usdt_candidates(raw: Decimal, unit: Decimal) -> list[Decimal]:
    if unit <= 0:
        return [raw.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)]
    steps = raw / unit
    floor_step = steps.to_integral_value(rounding=ROUND_FLOOR)
    ceil_step = steps.to_integral_value(rounding=ROUND_CEILING)
    nearest_step = steps.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    seen: set[Decimal] = set()
    for step in (floor_step - 1, floor_step, nearest_step, ceil_step, ceil_step + 1):
        if step < 0:
            continue
        val = (step * unit).quantize(unit, rounding=ROUND_HALF_UP)
        seen.add(val)
    return sorted(seen)


def _profit_metrics(
    *,
    bti_stake_krw: Decimal,
    bti_odds: Decimal,
    bc_odds: Decimal,
    bc_stake_usdt: Decimal,
    usdt_rate: Decimal,
) -> tuple[Decimal, Decimal, Decimal, Decimal, Decimal, Decimal]:
    bc_stake_krw = bc_stake_usdt * usdt_rate
    total_stake = bti_stake_krw + bc_stake_krw
    if total_stake <= 0:
        return Decimal("0"), Decimal("0"), Decimal("0"), Decimal("0"), Decimal("0"), Decimal("0")
    profit_x10 = (bti_stake_krw * bti_odds) - total_stake
    profit_bc = (bc_stake_usdt * bc_odds * usdt_rate) - total_stake
    rate_x10 = (profit_x10 / total_stake) * Decimal("100")
    rate_bc = (profit_bc / total_stake) * Decimal("100")
    min_profit = min(profit_x10, profit_bc)
    current_rate = min(rate_x10, rate_bc)
    return profit_x10, profit_bc, rate_x10, rate_bc, min_profit, current_rate


def pick_best_bc_stake_usdt(
    *,
    bti_stake_krw: float | int,
    bti_odds: float,
    bc_odds: float,
    usdt_rate: float,
    round_unit_usdt: float = 0.1,
) -> Decimal:
    x = _d(bti_stake_krw)
    a = _d(bti_odds)
    b = _d(bc_odds)
    r = _d(usdt_rate)
    unit = _d(round_unit_usdt)
    if b <= 0 or r <= 0:
        return Decimal("0")
    raw = (x * a) / b / r
    best_stake = Decimal("0")
    best_rate = Decimal("-999999")
    for candidate in _usdt_candidates(raw, unit):
        _, _, _, _, _, current_rate = _profit_metrics(
            bti_stake_krw=x,
            bti_odds=a,
            bc_odds=b,
            bc_stake_usdt=candidate,
            usdt_rate=r,
        )
        if current_rate > best_rate:
            best_rate = current_rate
            best_stake = candidate
    return best_stake


def compute_odds_only_metrics(
    *,
    bti_odds: float,
    bc_odds: float,
    bti_stake_krw: float | int,
    usdt_rate: float,
    round_unit_krw: int = 100,
    round_unit_usdt: float = 0.1,
    target_profit_pct: float = 0.0,
) -> OddsOnlyMetrics | None:
    a = _d(bti_odds)
    b = _d(bc_odds)
    if a < ODDS_MIN or a > ODDS_MAX or b < ODDS_MIN or b > ODDS_MAX:
        return None
    r = _d(usdt_rate)
    if r <= 0:
        return None

    x = _round_krw(_d(bti_stake_krw), round_unit_krw)
    y = pick_best_bc_stake_usdt(
        bti_stake_krw=float(x),
        bti_odds=float(a),
        bc_odds=float(b),
        usdt_rate=float(r),
        round_unit_usdt=round_unit_usdt,
    )
    profit_x10, profit_bc, rate_x10, rate_bc, min_profit, current_rate = _profit_metrics(
        bti_stake_krw=x,
        bti_odds=a,
        bc_odds=b,
        bc_stake_usdt=y,
        usdt_rate=r,
    )
    bc_stake_krw = y * r
    total = x + bc_stake_krw
    target = _d(target_profit_pct)
    return OddsOnlyMetrics(
        bti_odds=float(a),
        bc_odds=float(b),
        bti_stake_krw=float(x),
        bc_stake_usdt=float(y),
        bc_stake_krw=float(bc_stake_krw),
        total_stake_krw=float(total),
        profit_x10_krw=float(profit_x10),
        profit_bc_krw=float(profit_bc),
        profit_rate_x10=float(rate_x10),
        profit_rate_bc=float(rate_bc),
        min_profit_krw=float(min_profit),
        current_profit_rate=float(current_rate),
        target_profit_pct=float(target),
        target_delta_pct=float(current_rate - target),
    )


def odds_in_range(odds: float | None) -> bool:
    if odds is None:
        return False
    try:
        val = _d(odds)
    except Exception:
        return False
    return ODDS_MIN <= val <= ODDS_MAX
