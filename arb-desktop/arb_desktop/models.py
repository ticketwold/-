from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from time import perf_counter_ns
from typing import Any


class DetectionTier(str, Enum):
    NETWORK_WS = "network_ws"
    NETWORK_HTTP = "network_http"
    PLAYWRIGHT_DOM = "playwright_dom"
    OCR = "ocr"
    NONE = "none"


class SiteId(str, Enum):
    BTI_X10 = "bti_x10"
    BC_GAME = "bc_game"


@dataclass(slots=True)
class MoneylineSelection:
    team: str
    side: str
    decimal: float
    source_tier: DetectionTier = DetectionTier.NONE
    captured_ns: int = 0

    @property
    def latency_ms(self) -> float:
        if not self.captured_ns:
            return 0.0
        return max(0.0, (perf_counter_ns() - self.captured_ns) / 1_000_000)


@dataclass(slots=True)
class Matchup:
    site: SiteId
    event_id: str
    home: str
    away: str
    league: str = ""
    moneyline: list[MoneylineSelection] = field(default_factory=list)
    source_tier: DetectionTier = DetectionTier.NONE
    captured_ns: int = 0
    raw: dict[str, Any] | None = None

    @property
    def latency_ms(self) -> float:
        if not self.captured_ns:
            return 0.0
        return max(0.0, (perf_counter_ns() - self.captured_ns) / 1_000_000)


@dataclass(slots=True)
class ScanSnapshot:
    site: SiteId
    matchups: list[Matchup]
    tier: DetectionTier
    latency_ms: float
    ok: bool
    message: str = ""
    captured_ns: int = 0


@dataclass(slots=True)
class ArbOpportunity:
    home: str
    away: str
    league: str
    bti_side: str
    bti_odds: float
    bc_team: str
    bc_odds: float
    profit_pct: float
    bti_stake_krw: float
    bc_stake_usdt: float
    usdt_rate: float
    detection_ms: float
    calc_ms: float

    @property
    def total_latency_ms(self) -> float:
        return self.detection_ms + self.calc_ms


@dataclass(slots=True)
class EngineTick:
    bti: ScanSnapshot | None
    bc: ScanSnapshot | None
    opportunities: list[ArbOpportunity]
    tick_latency_ms: float
    calc_latency_ms: float
    betslip: Any | None = None
