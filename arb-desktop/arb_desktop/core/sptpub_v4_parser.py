from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from arb_desktop.models import DetectionTier, Matchup, MoneylineSelection, SiteId
from arb_desktop.timing import now_ns

# 컨테이너 — 우선 탐색
PRIORITY_CONTAINER_KEYS: tuple[str, ...] = (
    "markets",
    "outcomes",
    "selections",
    "market",
    "outcome",
    "selection",
    "events",
    "items",
    "data",
    "payload",
    "result",
)

# 배당 숫자가 들어있는 키 — 우선 검색
PRIORITY_ODDS_KEYS: tuple[str, ...] = (
    "odds",
    "coefficient",
    "price",
    "factor",
    "value",
    "k",
    "coef",
    "decimal",
    "decimalodds",
    "oddsvalue",
    "odd",
    "displayodds",
)

# status 등 — 배당으로 오인하면 안 되는 키
SKIP_VALUE_KEYS: frozenset[str] = frozenset(
    {
        "status",
        "state",
        "match_status",
        "matchstatus",
        "event_status",
        "active",
        "enabled",
        "visible",
        "suspended",
        "blocked",
        "rank",
        "position",
        "order",
        "priority",
        "score",
        "home_score",
        "away_score",
        "minute",
        "period",
        "period_id",
        "sport_id",
        "league_id",
        "category_id",
        "tournament_id",
        "market_id",
        "outcome_id",
        "selection_id",
        "event_id",
        "id",
        "version",
        "timestamp",
        "updated_at",
        "created_at",
        "code",
        "msg",
        "message",
        "success",
        "count",
        "total",
        "limit",
        "page",
        "type",
        "kind",
    }
)

# 이벤트 팀명 추출 키
HOME_KEYS: tuple[str, ...] = (
    "home",
    "homename",
    "home_name",
    "homeName",
    "competitor1",
    "competitorhome",
    "participant1name",
    "participant1",
    "team1",
    "w1",
)
AWAY_KEYS: tuple[str, ...] = (
    "away",
    "awayname",
    "away_name",
    "awayName",
    "competitor2",
    "competitoraway",
    "participant2name",
    "participant2",
    "team2",
    "w2",
)
NAME_KEYS: tuple[str, ...] = (
    "name",
    "teamname",
    "team_name",
    "teamName",
    "outcomename",
    "outcome_name",
    "outcomeName",
    "selectionname",
    "selection_name",
    "selectionName",
    "label",
    "title",
    "competitorname",
    "competitor_name",
)


@dataclass(slots=True)
class ParsedOutcome:
    team: str
    decimal: float
    market: str = ""
    source_key: str = ""
    outcome_id: str = ""


@dataclass(slots=True)
class ParsedEvent:
    event_id: str
    home: str
    away: str
    league: str = ""
    outcomes: list[ParsedOutcome] = field(default_factory=list)
    feed: str = ""  # live | prematch


def is_sptpub_v4_url(url: str) -> bool:
    u = (url or "").lower()
    return "sptpub" in u and "/api/v4/" in u


def sptpub_feed_from_url(url: str) -> str:
    u = (url or "").lower()
    if "/api/v4/live" in u:
        return "live"
    if "/api/v4/prematch" in u:
        return "prematch"
    return "unknown"


def parse_decimal_odds(value: Any, key: str | None = None) -> float | None:
    if key and key.lower() in SKIP_VALUE_KEYS:
        return None
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        n = float(value)
    else:
        s = str(value).strip().replace(",", "")
        if not s or not re.match(r"^-?\d+(\.\d+)?$", s):
            return None
        try:
            n = float(s)
        except ValueError:
            return None
    if not (1.01 <= n <= 100.0):
        return None
    return round(n, 4)


def _norm_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _pick_name(obj: dict[str, Any]) -> str:
    for k in NAME_KEYS:
        for rk, rv in obj.items():
            if _norm_key(rk) == _norm_key(k) and isinstance(rv, str) and len(rv.strip()) >= 2:
                return rv.strip()
    return ""


def _extract_competitors(obj: dict[str, Any]) -> tuple[str, str]:
    home = away = ""

    for k, v in obj.items():
        nk = _norm_key(k)
        if nk in {_norm_key(x) for x in HOME_KEYS} and isinstance(v, str):
            home = v.strip()
        if nk in {_norm_key(x) for x in AWAY_KEYS} and isinstance(v, str):
            away = v.strip()

    for ck in ("competitors", "competitor", "teams", "participants"):
        comp = obj.get(ck)
        if isinstance(comp, list) and len(comp) >= 2:
            names = []
            for c in comp:
                if isinstance(c, str) and len(c.strip()) >= 2:
                    names.append(c.strip())
                elif isinstance(c, dict):
                    n = _pick_name(c) or str(c.get("name") or c.get("title") or "").strip()
                    if len(n) >= 2:
                        names.append(n)
            if len(names) >= 2:
                return names[0], names[1]

        if isinstance(comp, dict):
            names = []
            for v in comp.values():
                if isinstance(v, dict):
                    n = _pick_name(v)
                    if n:
                        names.append(n)
            if len(names) >= 2:
                return names[0], names[1]

    desc = obj.get("desc") or obj.get("description") or obj.get("event")
    if isinstance(desc, dict):
        h2, a2 = _extract_competitors(desc)
        home = home or h2
        away = away or a2

    if not home or not away:
        for text_key in ("name", "title", "eventname", "event_name", "eventName", "desc"):
            raw = obj.get(text_key)
            if not isinstance(raw, str):
                continue
            m = re.search(
                r"([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,48})",
                raw,
                re.I,
            )
            if m:
                home, away = m.group(1).strip(), m.group(2).strip()
                break

    return home, away


def _event_id_from(obj: dict[str, Any], fallback: str = "") -> str:
    for k in ("id", "event_id", "eventId", "fixture_id", "fixtureId", "match_id", "matchId"):
        v = obj.get(k)
        if v is not None and str(v):
            return str(v)
    home, away = _extract_competitors(obj)
    if home and away:
        return f"{home}|{away}".lower()
    return fallback


@dataclass(slots=True)
class _WalkCtx:
    event_id: str = ""
    home: str = ""
    away: str = ""
    league: str = ""
    market: str = ""
    team_hint: str = ""
    feed: str = ""


class SptpubV4Parser:
    """sptpub /api/v4/live · /api/v4/prematch JSON 전체 재귀 탐색."""

    def __init__(self, feed: str = "unknown"):
        self.feed = feed
        self._events: dict[str, ParsedEvent] = {}

    def parse(self, data: Any) -> list[ParsedEvent]:
        self._events.clear()
        if isinstance(data, (str, bytes)):
            import orjson

            try:
                data = orjson.loads(data)
            except orjson.JSONDecodeError:
                return []
        self._walk(data, _WalkCtx(feed=self.feed), depth=0, path="")
        return list(self._events.values())

    def to_matchups(self, events: list[ParsedEvent], tier: DetectionTier) -> list[Matchup]:
        captured = now_ns()
        out: list[Matchup] = []
        for ev in events:
            if not ev.home or not ev.away:
                continue
            ml: list[MoneylineSelection] = []
            seen: set[tuple[str, float]] = set()
            for oc in ev.outcomes:
                if not oc.team or not oc.decimal:
                    continue
                key = (oc.team.lower(), round(oc.decimal, 3))
                if key in seen:
                    continue
                seen.add(key)
                ml.append(
                    MoneylineSelection(
                        team=oc.team,
                        side="",
                        decimal=oc.decimal,
                        source_tier=tier,
                        captured_ns=captured,
                    )
                )
            if not ml:
                continue
            out.append(
                Matchup(
                    site=SiteId.BC_GAME,
                    event_id=ev.event_id or f"{ev.home}|{ev.away}".lower(),
                    home=ev.home,
                    away=ev.away,
                    league=ev.league,
                    moneyline=ml,
                    source_tier=tier,
                    captured_ns=captured,
                )
            )
        return out

    def _ensure_event(self, ctx: _WalkCtx) -> str | None:
        if not ctx.home or not ctx.away:
            return None
        eid = ctx.event_id or f"{ctx.home}|{ctx.away}".lower()
        if eid not in self._events:
            self._events[eid] = ParsedEvent(
                event_id=eid,
                home=ctx.home,
                away=ctx.away,
                league=ctx.league,
                feed=ctx.feed,
            )
        return eid

    def _add_outcome(self, ctx: _WalkCtx, team: str, decimal: float, source_key: str) -> None:
        eid = self._ensure_event(ctx)
        if not eid or not team or len(team) < 2:
            return
        if team.lower() in {"draw", "x", "tie", "무승부"}:
            return
        ev = self._events[eid]
        for existing in ev.outcomes:
            if existing.team.lower() == team.lower() and abs(existing.decimal - decimal) < 0.02:
                return
        ev.outcomes.append(
            ParsedOutcome(
                team=team,
                decimal=decimal,
                market=ctx.market,
                source_key=source_key,
                outcome_id=ctx.event_id,
            )
        )

    def _walk(self, node: Any, ctx: _WalkCtx, depth: int, path: str) -> None:
        if depth > 24 or node is None:
            return

        if isinstance(node, list):
            for i, item in enumerate(node):
                self._walk(item, ctx, depth + 1, f"{path}[{i}]")
            return

        if not isinstance(node, dict):
            return

        local = _WalkCtx(
            event_id=ctx.event_id,
            home=ctx.home,
            away=ctx.away,
            league=ctx.league,
            market=ctx.market,
            team_hint=ctx.team_hint,
            feed=ctx.feed,
        )

        h, a = _extract_competitors(node)
        if h and a:
            local.home, local.away = h, a
            local.event_id = _event_id_from(node, local.event_id)
        for lk in ("league", "league_name", "leagueName", "tournament", "tournament_name", "category_name"):
            lv = node.get(lk)
            if isinstance(lv, str) and lv.strip():
                local.league = lv.strip()
                break

        mname = _pick_name(node) if any(_norm_key(k) in {"marketname", "market", "markettype"} for k in node) else ""
        for mk in ("market_name", "marketName", "market", "name", "type"):
            mv = node.get(mk)
            if isinstance(mv, str) and mv.strip() and _norm_key(mk) in {"marketname", "market", "name", "type"}:
                if re.search(r"winner|money|1x2|match|승|ml", mv, re.I):
                    local.market = mv.strip()
                    break

        team_hint = _pick_name(node)
        if team_hint:
            local.team_hint = team_hint

        # 우선순위 배당 키 직접 검색 (status 제외)
        for ok in PRIORITY_ODDS_KEYS:
            for rk, rv in node.items():
                if _norm_key(rk) != _norm_key(ok):
                    continue
                dec = parse_decimal_odds(rv, rk)
                if dec is None:
                    continue
                team = team_hint or local.team_hint
                if not team:
                    team = self._infer_team_from_context(local, node)
                if team:
                    self._add_outcome(local, team, dec, rk)

        # money_line / 1x2 flat 구조
        for hk, ak, dk in (("home", "away", "draw"), ("o1", "o2", "oX"), ("w1", "w2", "x")):
            hv, av, dv = node.get(hk), node.get(ak), node.get(dk)
            hd, ad, dd = parse_decimal_odds(hv, hk), parse_decimal_odds(av, ak), parse_decimal_odds(dv, dk)
            if local.home and hd:
                self._add_outcome(local, local.home, hd, hk)
            if local.away and ad:
                self._add_outcome(local, local.away, ad, ak)
            if dd and dk.lower() in {"draw", "x"}:
                pass  # skip draw for ML arb

        # 컨테이너 우선 재귀
        child_keys = sorted(
            node.keys(),
            key=lambda k: (
                0
                if _norm_key(k) in {_norm_key(x) for x in PRIORITY_CONTAINER_KEYS}
                else 1,
                k,
            ),
        )
        for ck in child_keys:
            if _norm_key(ck) in SKIP_VALUE_KEYS and _norm_key(ck) not in {_norm_key(x) for x in PRIORITY_CONTAINER_KEYS}:
                continue
            cv = node[ck]
            child_ctx = _WalkCtx(
                event_id=local.event_id,
                home=local.home,
                away=local.away,
                league=local.league,
                market=local.market,
                team_hint=local.team_hint,
                feed=local.feed,
            )
            if _norm_key(ck) in {_norm_key(x) for x in PRIORITY_CONTAINER_KEYS}:
                if isinstance(cv, dict):
                    for sub_k, sub_v in cv.items():
                        self._walk(sub_v, child_ctx, depth + 1, f"{path}.{ck}.{sub_k}")
                else:
                    self._walk(cv, child_ctx, depth + 1, f"{path}.{ck}")
            else:
                if isinstance(cv, (dict, list)):
                    self._walk(cv, child_ctx, depth + 1, f"{path}.{ck}")

    def _infer_team_from_context(self, ctx: _WalkCtx, node: dict[str, Any]) -> str:
        for side_key, team in (("side", None), ("position", None), ("type", None)):
            sv = node.get(side_key)
            if sv is None:
                continue
            s = str(sv).lower()
            if s in {"1", "home", "h", "w1"} and ctx.home:
                return ctx.home
            if s in {"2", "away", "a", "w2"} and ctx.away:
                return ctx.away
        return ""


def parse_sptpub_v4_payload(data: Any, feed: str = "unknown") -> list[ParsedEvent]:
    return SptpubV4Parser(feed=feed).parse(data)


def parse_sptpub_v4_matchups(
    data: Any,
    *,
    feed: str = "unknown",
    tier: DetectionTier = DetectionTier.NETWORK_HTTP,
) -> list[Matchup]:
    parser = SptpubV4Parser(feed=feed)
    events = parser.parse(data)
    return parser.to_matchups(events, tier)


def collect_display_odds_from_events(events: list[ParsedEvent]) -> dict[str, list[float]]:
    """화면 표시 배당 매칭 테스트용 — event_key -> [odds...]"""
    out: dict[str, list[float]] = {}
    for ev in events:
        key = f"{ev.home}|{ev.away}".lower()
        out[key] = sorted({oc.decimal for oc in ev.outcomes})
    return out


def match_display_odds(
    parsed: dict[str, list[float]],
    display: dict[str, list[float]],
    tolerance: float = 0.02,
) -> tuple[int, int, list[str]]:
    """parsed vs 화면 배당 매칭. returns (matched, total, errors)."""
    matched = 0
    total = 0
    errors: list[str] = []
    for key, display_odds in display.items():
        parsed_odds = parsed.get(key, [])
        for d in display_odds:
            total += 1
            if any(abs(d - p) <= tolerance for p in parsed_odds):
                matched += 1
            else:
                errors.append(f"{key}: display {d} not in parsed {parsed_odds}")
    return matched, total, errors
