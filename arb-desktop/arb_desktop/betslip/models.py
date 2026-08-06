from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from arb_desktop.betslip.normalize import EventPhase, MarketKind


class SlipStatus(str, Enum):
    ACTIVE = "ACTIVE"
    SUSPENDED = "SUSPENDED"
    CLOSED = "CLOSED"
    ODDS_MISSING = "ODDS_MISSING"
    EMPTY = "EMPTY"
    ERROR = "ERROR"
    NEEDS_REVIEW = "NEEDS_REVIEW"


_STATUS_MAP = {
    "active": SlipStatus.ACTIVE,
    "suspended": SlipStatus.SUSPENDED,
    "closed": SlipStatus.CLOSED,
    "odds_missing": SlipStatus.ODDS_MISSING,
    "empty": SlipStatus.EMPTY,
    "error": SlipStatus.ERROR,
    "needs_review": SlipStatus.NEEDS_REVIEW,
}


@dataclass(slots=True)
class BetSlipItem:
    site: str
    event: str = ""
    market: str = ""
    selection: str = ""
    odds: float | None = None
    status: SlipStatus = SlipStatus.EMPTY
    stake: float | None = None
    source: str = "dom"
    frame_url: str = ""
    container_selector: str = ""
    event_phase: EventPhase = EventPhase.UNKNOWN
    market_kind: MarketKind = MarketKind.UNKNOWN
    item_key: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(
        cls,
        site: str,
        data: dict[str, Any],
        *,
        frame_url: str = "",
        source: str = "dom",
        container_selector: str = "",
    ) -> BetSlipItem:
        status_raw = str(data.get("status") or "empty").lower()
        status = _STATUS_MAP.get(status_raw, SlipStatus.ERROR)

        odds_raw = data.get("odds")
        odds: float | None
        if odds_raw is None or odds_raw == "":
            odds = None
        else:
            try:
                odds = float(odds_raw)
            except (TypeError, ValueError):
                odds = None

        stake_raw = data.get("stake")
        stake: float | None
        if stake_raw is None or stake_raw == "":
            stake = None
        else:
            try:
                stake_val = float(stake_raw)
                stake = stake_val if stake_val > 0 else None
            except (TypeError, ValueError):
                stake = None

        phase_raw = str(data.get("event_phase") or data.get("phase") or "unknown").lower()
        try:
            event_phase = EventPhase(phase_raw)
        except ValueError:
            event_phase = EventPhase.UNKNOWN

        market_kind_raw = str(data.get("market_kind") or "unknown").lower()
        try:
            market_kind = MarketKind(market_kind_raw)
        except ValueError:
            market_kind = MarketKind.UNKNOWN

        return cls(
            site=site,
            event=str(data.get("event") or "").strip(),
            market=str(data.get("market") or "").strip(),
            selection=str(data.get("selection") or "").strip(),
            odds=odds,
            status=status,
            stake=stake,
            source=str(data.get("source") or source or "dom"),
            frame_url=str(data.get("frame_url") or frame_url or ""),
            container_selector=str(data.get("container_selector") or container_selector or ""),
            event_phase=event_phase,
            market_kind=market_kind,
            item_key=str(data.get("item_key") or ""),
            raw=data,
        )


@dataclass(slots=True)
class BetSlipReadResult:
    site: str
    ok: bool
    empty: bool = True
    items: list[BetSlipItem] = field(default_factory=list)
    frame_url: str = ""
    source: str = "dom"
    container_selector: str = ""
    reason: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def first(self) -> BetSlipItem | None:
        return self.items[0] if self.items else None


@dataclass(slots=True)
class MatchCheckResult:
    same_event: bool
    same_market: bool
    opposite_selection: bool
    network_verified: bool
    safe_to_calculate: bool
    reason: str = ""


@dataclass(slots=True)
class ArbitrageResult:
    odds_a: float | None
    odds_b: float | None
    implied_probability_sum: float | None
    arb_possible: bool
    profit_rate: float | None
    stake_a: float | None
    stake_b: float | None
    return_a: float | None
    return_b: float | None
    base_site: str = ""
    hedge_site: str = ""


@dataclass(slots=True)
class BetSlipScanResult:
    bc: BetSlipReadResult
    bti: BetSlipReadResult
    match: MatchCheckResult
    arbitrage: ArbitrageResult | None = None
