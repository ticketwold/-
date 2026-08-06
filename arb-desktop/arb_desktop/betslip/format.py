from __future__ import annotations

from arb_desktop.betslip.models import BetSlipItem, SlipStatus


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
    lines = [
        "[BETSLIP]",
        f"site: {item.site}",
        f"event: {item.event or '-'}",
        f"selection: {item.selection or '-'}",
        f"odds: {format_odds(item.odds)}",
        f"status: {item.status.value}",
        f"stake: {format_stake(item.stake)}",
    ]
    return "\n".join(lines)


def empty_betslip_block(site: str, status: SlipStatus = SlipStatus.EMPTY, reason: str = "") -> str:
    item = BetSlipItem(site=site, status=status, raw={"reason": reason} if reason else {})
    return format_betslip_block(item)
