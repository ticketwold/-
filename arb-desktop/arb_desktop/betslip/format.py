from __future__ import annotations

from arb_desktop.betslip.models import (
    ArbitrageResult,
    BetSlipItem,
    BetSlipReadResult,
    BetSlipScanResult,
    MatchCheckResult,
    SlipStatus,
)
from arb_desktop.betslip.matcher import apply_network_verification, calculate_arbitrage, check_slip_pair
from arb_desktop.config import settings


def format_bool(value: bool) -> str:
    return "true" if value else "false"


def format_odds(odds: float | None) -> str:
    if odds is None:
        return "-"
    return f"{odds:.3f}".rstrip("0").rstrip(".")


def format_stake(stake: float | None) -> str:
    if stake is None or stake <= 0:
        return "-"
    if abs(stake - round(stake)) < 0.001:
        return str(int(round(stake)))
    return f"{stake:g}"


def format_betslip_block(item: BetSlipItem) -> str:
    return "\n".join(
        [
            "[BETSLIP]",
            f"site: {item.site}",
            f"event: {item.event or '-'}",
            f"market: {item.market or '-'}",
            f"selection: {item.selection or '-'}",
            f"odds: {format_odds(item.odds)}",
            f"status: {item.status.value}",
            f"stake: {format_stake(item.stake)}",
            f"source: {item.source or 'dom'}",
            f"frame_url: {item.frame_url or '-'}",
            f"container_selector: {item.container_selector or '-'}",
        ]
    )


def empty_betslip_block(site: str, status: SlipStatus = SlipStatus.EMPTY, reason: str = "") -> str:
    item = BetSlipItem(site=site, status=status, source="dom", raw={"reason": reason} if reason else {})
    return format_betslip_block(item)


def format_match_check(match: MatchCheckResult) -> str:
    return "\n".join(
        [
            "[MATCH CHECK]",
            f"same_event: {format_bool(match.same_event)}",
            f"same_market: {format_bool(match.same_market)}",
            f"opposite_selection: {format_bool(match.opposite_selection)}",
            f"network_verified: {format_bool(match.network_verified)}",
            f"safe_to_calculate: {format_bool(match.safe_to_calculate)}",
            f"reason: {match.reason or '-'}",
        ]
    )


def format_arbitrage(arb: ArbitrageResult | None) -> str:
    if not arb:
        return "\n".join(
            [
                "[ARBITRAGE]",
                "odds_a: -",
                "odds_b: -",
                "implied_probability_sum: -",
                "arb_possible: false",
                "profit_rate: -",
                "stake_a: -",
                "stake_b: -",
                "return_a: -",
                "return_b: -",
            ]
        )

    return "\n".join(
        [
            "[ARBITRAGE]",
            f"odds_a: {format_odds(arb.odds_a)}",
            f"odds_b: {format_odds(arb.odds_b)}",
            f"implied_probability_sum: {arb.implied_probability_sum if arb.implied_probability_sum is not None else '-'}",
            f"arb_possible: {format_bool(arb.arb_possible)}",
            f"profit_rate: {arb.profit_rate if arb.profit_rate is not None else '-'}",
            f"stake_a: {format_stake(arb.stake_a)}",
            f"stake_b: {format_stake(arb.stake_b)}",
            f"return_a: {format_stake(arb.return_a)}",
            f"return_b: {format_stake(arb.return_b)}",
        ]
    )


def format_scan_report(result: BetSlipScanResult) -> str:
    parts: list[str] = []

    if result.bc.first:
        parts.append(format_betslip_block(result.bc.first))
    else:
        parts.append(empty_betslip_block(result.bc.site or "BC.Game", SlipStatus.EMPTY, result.bc.reason))

    parts.append("")

    if result.bti.first:
        parts.append(format_betslip_block(result.bti.first))
    else:
        parts.append(empty_betslip_block(result.bti.site or "x10x10s", SlipStatus.EMPTY, result.bti.reason))

    parts.append("")
    parts.append(format_match_check(result.match))
    parts.append("")
    parts.append(format_arbitrage(result.arbitrage))
    return "\n".join(parts)
