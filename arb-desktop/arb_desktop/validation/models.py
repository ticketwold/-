from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class MatchFailReason(str, Enum):
    EVENT_ID_MISMATCH = "event id 불일치"
    TEAM_NAME_NORMALIZATION_FAILED = "team name 정규화 실패"
    MARKET_TYPE_MISMATCH = "market type 불일치"
    API_EVENT_NOT_FOUND = "API 경기 없음"
    SCREEN_EVENT_NOT_FOUND = "화면 경기 없음"
    ODDS_COUNT_MISMATCH = "배당 개수 불일치"


@dataclass(slots=True)
class TeamOdds:
    team: str
    decimal: float
    market: str = ""
    source: str = ""  # api | screen


@dataclass(slots=True)
class VerifyEvent:
    event_id: str
    home: str
    away: str
    title: str
    league: str = ""
    odds: list[TeamOdds] = field(default_factory=list)
    feed: str = ""  # live | prematch | screen


@dataclass(slots=True)
class OddsDiff:
    team: str
    api_odds: float | None
    screen_odds: float | None

    @property
    def delta(self) -> float | None:
        if self.api_odds is None or self.screen_odds is None:
            return None
        return round(self.screen_odds - self.api_odds, 4)


@dataclass(slots=True)
class EventMatchResult:
    matched: bool
    title: str
    api_event: VerifyEvent | None = None
    screen_event: VerifyEvent | None = None
    odds_diffs: list[OddsDiff] = field(default_factory=list)
    fail_reasons: list[MatchFailReason] = field(default_factory=list)
    detail: str = ""

    @property
    def max_odds_delta(self) -> float:
        deltas = [abs(d.delta) for d in self.odds_diffs if d.delta is not None]
        return max(deltas) if deltas else 0.0


@dataclass(slots=True)
class LiveVerifyReport:
    api_events: list[VerifyEvent]
    screen_events: list[VerifyEvent]
    matches: list[EventMatchResult]
    unmatched_api: list[VerifyEvent]
    unmatched_screen: list[VerifyEvent]
    api_source: str = ""
    screen_source: str = ""

    @property
    def matched_count(self) -> int:
        return sum(1 for m in self.matches if m.matched)

    @property
    def failed_count(self) -> int:
        return len(self.matches) - self.matched_count + len(self.unmatched_api) + len(self.unmatched_screen)
