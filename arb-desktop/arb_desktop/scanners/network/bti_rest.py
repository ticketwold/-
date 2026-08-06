from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

import httpx
import orjson

from arb_desktop.config import settings
from arb_desktop.core.odds_engine import parse_bti_selection_price
from arb_desktop.core.team_matcher import is_bti_away_side, is_bti_home_side
from arb_desktop.models import DetectionTier, Matchup, MoneylineSelection, SiteId
from arb_desktop.scanners.tiers import NetworkScanner
from arb_desktop.timing import now_ns

BTI_HOST_HINTS = ("bti-sports.io", "bti-sports.com", "live8588.com", "fxf774.com")


def _market_types_param() -> str:
    return quote(settings.bti_market_types, safe="")


class BtiRestScanner(NetworkScanner):
    """1순위: BTI sportscenter REST API (세션 쿠키 필요)."""

    tier = DetectionTier.NETWORK_HTTP

    def __init__(self, cookies: httpx.Cookies | None = None, origin: str | None = None):
        self._cookies = cookies or httpx.Cookies()
        self._origin = origin
        self._client: httpx.AsyncClient | None = None

    def set_session(self, origin: str, cookies: httpx.Cookies) -> None:
        self._origin = origin.rstrip("/")
        self._cookies = cookies

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                cookies=self._cookies,
                timeout=settings.network_timeout_ms / 1000,
                follow_redirects=True,
                headers={"Accept": "application/json"},
            )
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    def _api_paths(self) -> list[str]:
        mt = _market_types_param()
        lang = settings.bti_language
        min_odds = settings.bti_minimum_odds
        return [
            f"/api/sportscenter/inplay/markets?language={lang}&marketTypes={mt}&minimumOdds={min_odds}&draft=false",
            f"/api/sportscenter/prematch/markets?language={lang}&marketTypes={mt}&minimumOdds={min_odds}&draft=false",
        ]

    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        if not self._origin:
            return [], "BTI origin not discovered — open x10x10s sports in browser first"

        client = await self._ensure_client()
        all_events: list[dict[str, Any]] = []
        for path in self._api_paths():
            url = f"{self._origin}{path}"
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    continue
                data = orjson.loads(resp.content)
                events = data if isinstance(data, list) else data.get("data") or data.get("events") or []
                if isinstance(events, list):
                    all_events.extend(events)
            except Exception as exc:
                return [], f"BTI API error: {exc}"

        matchups = self._convert_events(all_events)
        return matchups, f"BTI REST {len(matchups)} matchups from {self._origin}"

    def _convert_events(self, events: list[dict[str, Any]]) -> list[Matchup]:
        out: list[Matchup] = []
        seen: set[str] = set()
        captured = now_ns()

        for event in events:
            eid = str(event.get("id") or event.get("eventId") or "")
            markets = event.get("markets") or []
            if not markets:
                continue

            home = away = ""
            ml_selections: list[MoneylineSelection] = []

            for market in markets:
                type_id = str((market.get("MarketType") or {}).get("_id") or market.get("_id") or "")
                kind = market.get("marketKind") or ""
                if type_id and not type_id.startswith("ML") and kind and kind != "ml":
                    continue
                if not type_id and kind and kind != "ml":
                    continue

                for sel in market.get("Selections") or []:
                    side = str(sel.get("Side") or "")
                    odds = parse_bti_selection_price(sel)
                    if odds <= 1:
                        continue
                    name = sel.get("Name") or sel.get("TeamName") or ""
                    if is_bti_home_side(side) and not home:
                        home = name
                    if is_bti_away_side(side) and not away:
                        away = name
                    ml_selections.append(
                        MoneylineSelection(team=name, side=side, decimal=odds, source_tier=self.tier, captured_ns=captured)
                    )

            if not home or not away:
                event_name = (markets[0] or {}).get("EventName") or event.get("EventName") or ""
                parts = re.split(r"\s+vs\.?\s+", event_name, maxsplit=1, flags=re.I)
                if len(parts) == 2:
                    home, away = parts[0].strip(), parts[1].strip()

            key = f"{home}|{away}".lower()
            if not home or not away or key in seen or len(ml_selections) < 2:
                continue
            seen.add(key)
            out.append(
                Matchup(
                    site=SiteId.BTI_X10,
                    event_id=eid or key,
                    home=home,
                    away=away,
                    moneyline=ml_selections[:2],
                    source_tier=self.tier,
                    captured_ns=captured,
                    raw=event,
                )
            )
        return out


def detect_bti_origin_from_url(url: str) -> str | None:
    for hint in BTI_HOST_HINTS:
        if hint in url:
            from urllib.parse import urlparse

            p = urlparse(url)
            return f"{p.scheme}://{p.netloc}"
    return None
