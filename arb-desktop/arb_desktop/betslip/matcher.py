from __future__ import annotations

from arb_desktop.betslip.models import ArbitrageResult, BetSlipItem, BetSlipReadResult, MatchCheckResult, SlipStatus
from arb_desktop.betslip.normalize import event_match_confidence, market_match, opposite_selection
from arb_desktop.core.odds_engine import calc_arb, calc_bc_stake_usdt


def _valid_odds(odds: float | None) -> bool:
    return odds is not None and 1.01 < odds < 100.0


def check_slip_pair(bc: BetSlipReadResult, bti: BetSlipReadResult) -> MatchCheckResult:
    bc_item = bc.first
    bti_item = bti.first

    if bc.empty or bti.empty or not bc_item or not bti_item:
        return MatchCheckResult(
            same_event=False,
            same_market=False,
            opposite_selection=False,
            network_verified=False,
            safe_to_calculate=False,
            reason="one-or-both-slips-empty",
        )

    if bc_item.status != SlipStatus.ACTIVE or bti_item.status != SlipStatus.ACTIVE:
        return MatchCheckResult(
            same_event=False,
            same_market=False,
            opposite_selection=False,
            network_verified=False,
            safe_to_calculate=False,
            reason=f"inactive-status:bc={bc_item.status.value},bti={bti_item.status.value}",
        )

    if not _valid_odds(bc_item.odds) or not _valid_odds(bti_item.odds):
        return MatchCheckResult(
            same_event=False,
            same_market=False,
            opposite_selection=False,
            network_verified=False,
            safe_to_calculate=False,
            reason="odds-missing-or-out-of-range",
        )

    same_event, event_reason = event_match_confidence(bc_item.event, bti_item.event)
    same_market, market_reason = market_match(
        bc_item.market,
        bc_item.selection,
        bti_item.market,
        bti_item.selection,
    )
    opposite, opposite_reason = opposite_selection(
        event_a=bc_item.event,
        selection_a=bc_item.selection,
        market_a=bc_item.market,
        event_b=bti_item.event,
        selection_b=bti_item.selection,
        market_b=bti_item.market,
    )

    reasons: list[str] = []
    if not same_event:
        reasons.append(event_reason)
    if not same_market:
        reasons.append(market_reason)
    if not opposite:
        reasons.append(opposite_reason)

    safe = same_event and same_market and opposite
    return MatchCheckResult(
        same_event=same_event,
        same_market=same_market,
        opposite_selection=opposite,
        network_verified=False,
        safe_to_calculate=safe,
        reason=";".join(reasons) if reasons else "ok",
    )


def apply_network_verification(
    match: MatchCheckResult,
    *,
    bc_dom_odds: float | None,
    bti_dom_odds: float | None,
    bc_network_odds: float | None,
    bti_network_odds: float | None,
    tolerance: float = 0.06,
) -> MatchCheckResult:
    if bc_network_odds is None and bti_network_odds is None:
        return MatchCheckResult(
            same_event=match.same_event,
            same_market=match.same_market,
            opposite_selection=match.opposite_selection,
            network_verified=False,
            safe_to_calculate=False,
            reason=f"{match.reason};network-unavailable" if match.reason else "network-unavailable",
        )

    if bc_network_odds is None or bti_network_odds is None:
        return MatchCheckResult(
            same_event=match.same_event,
            same_market=match.same_market,
            opposite_selection=match.opposite_selection,
            network_verified=False,
            safe_to_calculate=False,
            reason=f"{match.reason};network-partial" if match.reason else "network-partial",
        )

    bc_dom_ok = bc_dom_odds is not None and abs(bc_dom_odds - bc_network_odds) <= tolerance
    bti_dom_ok = bti_dom_odds is not None and abs(bti_dom_odds - bti_network_odds) <= tolerance
    network_verified = bc_dom_ok and bti_dom_ok

    safe = match.safe_to_calculate and network_verified
    reason = match.reason
    if not network_verified:
        reason = f"{reason};network-dom-mismatch" if reason else "network-dom-mismatch"

    return MatchCheckResult(
        same_event=match.same_event,
        same_market=match.same_market,
        opposite_selection=match.opposite_selection,
        network_verified=network_verified,
        safe_to_calculate=safe,
        reason=reason,
    )


def calculate_arbitrage(
    bc: BetSlipItem,
    bti: BetSlipItem,
    *,
    bti_base_stake_krw: float = 10_000,
    usdt_rate: float = 1400.0,
) -> ArbitrageResult | None:
    if not _valid_odds(bc.odds) or not _valid_odds(bti.odds):
        return None

    odds_a = bc.odds
    odds_b = bti.odds
    assert odds_a is not None and odds_b is not None

    implied = (1.0 / odds_a) + (1.0 / odds_b)
    profit = calc_arb(odds_a, odds_b)
    arb_possible = profit is not None and profit > 0

    stake_b = float(bti_base_stake_krw)
    stake_a = calc_bc_stake_usdt(stake_b, odds_b, odds_a, usdt_rate)

    return_a = stake_a * odds_a if stake_a else None
    return_b = stake_b * odds_b if stake_b else None

    return ArbitrageResult(
        odds_a=odds_a,
        odds_b=odds_b,
        implied_probability_sum=round(implied, 6),
        arb_possible=arb_possible,
        profit_rate=round(profit, 4) if profit is not None else None,
        stake_a=stake_a,
        stake_b=stake_b,
        return_a=round(return_a, 2) if return_a else None,
        return_b=round(return_b, 2) if return_b else None,
        base_site=bti.site,
        hedge_site=bc.site,
    )
