from __future__ import annotations

import re
from enum import Enum

from arb_desktop.core.team_matcher import matchup_teams_match, norm_team, team_match


class MarketKind(str, Enum):
    MONEYLINE = "moneyline"
    OVER_UNDER = "over_under"
    HANDICAP = "handicap"
    UNKNOWN = "unknown"


class EventPhase(str, Enum):
    LIVE = "live"
    PREMATCH = "prematch"
    UNKNOWN = "unknown"


ML_ALIASES = (
    "moneyline",
    "match winner",
    "winner",
    "win",
    "승자",
    "승패",
    "우승",
    "맵 우승",
    "map winner",
)
OU_ALIASES = ("over/under", "over under", "total", "오버", "언더", "over", "under", "합계", "득점")
AH_ALIASES = ("handicap", "asian handicap", "핸디", "핸디캡", "spread", "맵 핸디")


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def normalize_market_name(market: str, selection: str = "") -> MarketKind:
    blob = normalize_text(f"{market} {selection}")
    if any(alias in blob for alias in OU_ALIASES) or re.search(r"\b(over|under|오버|언더)\b", blob):
        return MarketKind.OVER_UNDER
    if any(alias in blob for alias in AH_ALIASES) or re.search(r"[+-]\d+(?:\.\d+)?", selection or ""):
        return MarketKind.HANDICAP
    if any(alias in blob for alias in ML_ALIASES) or re.search(r"\bw[12]\b", blob):
        return MarketKind.MONEYLINE
    return MarketKind.UNKNOWN


def parse_event_teams(event: str) -> tuple[str, str]:
    if not event:
        return "", ""
    m = re.match(
        r"^\s*([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{0,60}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{0,60}?)\s*$",
        event,
        re.I,
    )
    if not m:
        return "", ""
    return m.group(1).strip(), m.group(2).strip()


def event_match_confidence(event_a: str, event_b: str) -> tuple[bool, str]:
    home_a, away_a = parse_event_teams(event_a)
    home_b, away_b = parse_event_teams(event_b)
    if not all([home_a, away_a, home_b, away_b]):
        return False, "event-parse-incomplete"

    na = norm_team(home_a) + norm_team(away_a)
    nb = norm_team(home_b) + norm_team(away_b)
    if na == nb:
        return True, "exact-normalized"

    if matchup_teams_match(home_a, away_a, home_b, away_b):
        # Require both team pairs to match strongly (not substring-only on one side)
        direct = team_match(home_a, home_b) and team_match(away_a, away_b)
        swapped = team_match(home_a, away_b) and team_match(away_a, home_b)
        if direct or swapped:
            return True, "team-pair-match"
        return False, "needs-review-partial-team-match"

    return False, "different-event"


def market_match(market_a: str, selection_a: str, market_b: str, selection_b: str) -> tuple[bool, str]:
    kind_a = normalize_market_name(market_a, selection_a)
    kind_b = normalize_market_name(market_b, selection_b)
    if kind_a == MarketKind.UNKNOWN or kind_b == MarketKind.UNKNOWN:
        return False, "unknown-market"
    if kind_a != kind_b:
        return False, f"market-kind-mismatch:{kind_a.value}!={kind_b.value}"
    return True, kind_a.value


def _ou_side(selection: str) -> str | None:
    s = normalize_text(selection)
    if re.search(r"\b(over|오버)\b", s):
        return "over"
    if re.search(r"\b(under|언더)\b", s):
        return "under"
    return None


def _ou_line(selection: str) -> float | None:
    m = re.search(r"([+-]?\d+(?:\.\d+)?)", selection or "")
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _handicap_line(selection: str) -> float | None:
    m = re.search(r"([+-]\d+(?:\.\d+)?)\s*$", (selection or "").strip())
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def opposite_selection(
    *,
    event_a: str,
    selection_a: str,
    market_a: str,
    event_b: str,
    selection_b: str,
    market_b: str,
) -> tuple[bool, str]:
    same_market, market_reason = market_match(market_a, selection_a, market_b, selection_b)
    if not same_market:
        return False, market_reason

    kind = normalize_market_name(market_a, selection_a)
    home_a, away_a = parse_event_teams(event_a)
    home_b, away_b = parse_event_teams(event_b)

    if kind == MarketKind.MONEYLINE:
        sel_a = normalize_text(selection_a)
        sel_b = normalize_text(selection_b)
        if sel_a in {"w1", "1"} and sel_b in {"w2", "2"}:
            return True, "w1-vs-w2"
        if sel_a in {"w2", "2"} and sel_b in {"w1", "1"}:
            return True, "w2-vs-w1"

        if norm_team(selection_a) == norm_team(selection_b):
            return False, "same-selection"

        a_home = team_match(selection_a, home_a) or team_match(selection_a, home_b)
        a_away = team_match(selection_a, away_a) or team_match(selection_a, away_b)
        b_home = team_match(selection_b, home_a) or team_match(selection_b, home_b)
        b_away = team_match(selection_b, away_a) or team_match(selection_b, away_b)

        if a_home and b_away:
            return True, "home-vs-away"
        if a_away and b_home:
            return True, "away-vs-home"
        return False, "ml-not-opposite"

    if kind == MarketKind.OVER_UNDER:
        side_a = _ou_side(selection_a)
        side_b = _ou_side(selection_b)
        line_a = _ou_line(selection_a)
        line_b = _ou_line(selection_b)
        if not side_a or not side_b:
            return False, "ou-side-unknown"
        if side_a == side_b:
            return False, "same-ou-side"
        if line_a is not None and line_b is not None and abs(line_a - line_b) > 0.02:
            return False, "ou-line-mismatch"
        return True, "over-vs-under"

    if kind == MarketKind.HANDICAP:
        line_a = _handicap_line(selection_a)
        line_b = _handicap_line(selection_b)
        if line_a is None or line_b is None:
            return False, "handicap-line-missing"
        if abs(line_a + line_b) > 0.05:
            return False, "handicap-not-opposite-line"
        if team_match(selection_a, selection_b):
            return False, "same-handicap-team"
        return True, "handicap-opposite"

    return False, "unsupported-market"
