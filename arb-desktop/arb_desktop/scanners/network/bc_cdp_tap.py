from __future__ import annotations

import asyncio
from typing import Any, Callable

import orjson

from arb_desktop.config import settings
from arb_desktop.core.json_odds import extract_slip_from_json, url_matches_bc_patterns
from arb_desktop.core.sptpub_v4_parser import is_sptpub_v4_url
from arb_desktop.models import DetectionTier, Matchup, MoneylineSelection, SiteId
from arb_desktop.scanners.network.sptpub_v4 import SptpubV4Client
from arb_desktop.scanners.tiers import NetworkScanner
from arb_desktop.timing import now_ns

# In-memory board cache updated by CDP network tap
_board_cache: dict[str, Any] = {"matchups": [], "updated_ns": 0}


BC_BOARD_JS = """
() => {
  const seen = new Set();
  const picks = [];
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r || r.width < 2 || r.height < 2) return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    } catch (_) {}
    return true;
  }
  function parseOdds(t) {
    const n = parseFloat(String(t||'').replace(/,/g,'').trim());
    return Number.isFinite(n) && n > 1.01 && n < 100 ? n : null;
  }
  function parseTeams(t) {
    if (!t) return null;
    const s = String(t).replace(/\\s+/g,' ').trim();
    let m = s.match(/([A-Za-z0-9가-힣][^\\n]{1,48}?)\\s+vs\\.?\\s+([A-Za-z0-9가-힣][^\\n]{1,48})/i);
    if (m) return { home: m[1].trim(), away: m[2].trim() };
    return null;
  }
  function findEvent(el) {
    let node = el;
    for (let i = 0; i < 14 && node; i++) {
      const home = node.querySelector?.('[data-editor-id*="competitorHome"], [data-editor-id*="CompetitorHome"]');
      const away = node.querySelector?.('[data-editor-id*="competitorAway"], [data-editor-id*="CompetitorAway"]');
      if (home && away) {
        const h = (home.textContent||'').trim(), a = (away.textContent||'').trim();
        if (h.length >= 2 && a.length >= 2) return { home: h, away: a };
      }
      const teams = parseTeams(node.textContent);
      if (teams) return teams;
      node = node.parentElement;
    }
    return null;
  }
  const sels = [
    '[data-editor-id*="outcome"]', '[data-editor-id*="OddsButton"]',
    'button[data-editor-id]', 'button', '[role="button"]',
    '[class*="Outcome"]', '[class*="Selection"]'
  ];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el)) continue;
      const txt = (el.textContent||'').replace(/\\s+/g,' ').trim();
      const m = txt.match(/(\\d+\\.\\d{2,3})\\s*$/);
      const odds = m ? parseOdds(m[1]) : parseOdds(txt);
      if (!odds) continue;
      const ev = findEvent(el);
      if (!ev) continue;
      const key = `${ev.home}|${ev.away}|${odds}|${txt}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push({ ...ev, odds, txt });
    }
  }
  const map = new Map();
  for (const p of picks) {
    const key = `${p.home}|${p.away}`.toLowerCase();
    if (!map.has(key)) map.set(key, { home: p.home, away: p.away, ml: [] });
    const mu = map.get(key);
    let team = p.txt.replace(/(\\d+\\.\\d{2,3})\\s*$/, '').trim();
    if (/^W1$|^1$/i.test(team)) team = p.home;
    if (/^W2$|^2$/i.test(team)) team = p.away;
    if (!team || team.length < 2 || team === 'Draw') continue;
    if (!mu.ml.some(x => x.team === team && Math.abs(x.decimal - p.odds) < 0.02))
      mu.ml.push({ team, decimal: p.odds });
  }
  return { matchups: [...map.values()].filter(m => m.ml.length), count: picks.length };
}
"""


class BcCdpNetworkTap(NetworkScanner):
    """1순위: Playwright CDP로 HTTP + WebSocket 원본 JSON 감지."""

    tier = DetectionTier.NETWORK_WS

    def __init__(self) -> None:
        self._matchups: list[Matchup] = []
        self._message = "CDP tap not started"
        self._handlers: list[Callable] = []
        self._page = None
        self._cdp = None

    async def attach(self, page) -> None:
        self._page = page
        self._cdp = await page.context.new_cdp_session(page)
        await self._cdp.send("Network.enable")

        def on_response(params: dict) -> None:
            try:
                url = params.get("response", {}).get("url", "")
                if not url_matches_bc_patterns(url, settings.bc_url_patterns):
                    return
                request_id = params.get("requestId")
                if not request_id:
                    return
                asyncio.create_task(self._read_response(request_id, url))
            except Exception:
                pass

        def on_ws_frame(params: dict) -> None:
            try:
                payload = params.get("response", {}).get("payloadData")
                if not payload:
                    return
                self._ingest_payload(payload, "websocket")
            except Exception:
                pass

        self._cdp.on("Network.responseReceived", on_response)
        self._cdp.on("Network.webSocketFrameReceived", on_ws_frame)
        self._message = "CDP network tap attached"

    async def _read_response(self, request_id: str, url: str) -> None:
        try:
            body = await self._cdp.send("Network.getResponseBody", {"requestId": request_id})
            raw = body.get("body", "")
            if body.get("base64Encoded"):
                import base64

                raw = base64.b64decode(raw)
            self._ingest_payload(raw, url)
        except Exception:
            pass

    def _ingest_payload(self, raw: str | bytes, source: str) -> None:
        slip = extract_slip_from_json(raw)
        if slip and slip.get("odds"):
            self._message = f"network slip @ {source[:60]} odds={slip['odds']}"

        try:
            # sptpub /api/v4/live · /api/v4/prematch — JSON 전체 재귀 탐색
            if is_sptpub_v4_url(source):
                matchups = SptpubV4Client.parse_cdp_payload(raw, source)
                if matchups:
                    self._merge_matchups(matchups, source)
                    return

            data = orjson.loads(raw) if isinstance(raw, (str, bytes)) else raw
            matchups = self._parse_board_json(data)
            if matchups:
                self._merge_matchups(matchups, source)
        except Exception:
            pass

    def _merge_matchups(self, matchups: list[Matchup], source: str) -> None:
        if not matchups:
            return
        merged: dict[str, Matchup] = {m.event_id: m for m in self._matchups}
        for m in matchups:
            key = m.event_id or f"{m.home}|{m.away}".lower()
            if key not in merged or len(m.moneyline) > len(merged[key].moneyline):
                merged[key] = m
        self._matchups = list(merged.values())
        _board_cache["matchups"] = [m.__dict__ for m in self._matchups]
        _board_cache["updated_ns"] = now_ns()
        self._message = f"network board {len(self._matchups)} from {source[:48]}"

    def _parse_board_json(self, data: Any) -> list[Matchup]:
        """Best-effort recursive event extraction from BetBy JSON blobs."""
        events: list[Matchup] = []
        captured = now_ns()

        def walk(obj: Any, depth: int = 0) -> None:
            if depth > 12 or obj is None:
                return
            if isinstance(obj, list):
                for item in obj:
                    walk(item, depth + 1)
                return
            if not isinstance(obj, dict):
                return

            home = obj.get("homeName") or obj.get("home") or obj.get("competitor1") or ""
            away = obj.get("awayName") or obj.get("away") or obj.get("competitor2") or ""
            if isinstance(home, dict):
                home = home.get("name") or ""
            if isinstance(away, dict):
                away = away.get("name") or ""

            odds_list: list[MoneylineSelection] = []
            for key in ("outcomes", "selections", "markets"):
                for item in obj.get(key) or []:
                    if not isinstance(item, dict):
                        continue
                    name = item.get("name") or item.get("teamName") or item.get("outcomeName") or ""
                    odds = item.get("odds") or item.get("price") or item.get("coefficient")
                    try:
                        dec = float(odds)
                        if 1.01 < dec < 100 and name:
                            odds_list.append(
                                MoneylineSelection(team=str(name), side="", decimal=dec, source_tier=self.tier, captured_ns=captured)
                            )
                    except (TypeError, ValueError):
                        pass

            if home and away and len(odds_list) >= 2:
                key = f"{home}|{away}".lower()
                if not any(m.event_id == key for m in events):
                    events.append(
                        Matchup(
                            site=SiteId.BC_GAME,
                            event_id=key,
                            home=str(home),
                            away=str(away),
                            moneyline=odds_list[:2],
                            source_tier=self.tier,
                            captured_ns=captured,
                        )
                    )

            for v in obj.values():
                if isinstance(v, (dict, list)):
                    walk(v, depth + 1)

        walk(data)
        return events

    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        if self._matchups:
            return self._matchups, self._message
        if self._page:
            try:
                result = await self._page.evaluate(BC_BOARD_JS)
                matchups = self._dom_result_to_matchups(result)
                if matchups:
                    return matchups, "CDP tap + inline DOM eval"
            except Exception as exc:
                return [], f"CDP fallback DOM: {exc}"
        return [], self._message

    def _dom_result_to_matchups(self, result: dict | None) -> list[Matchup]:
        if not result or not result.get("matchups"):
            return []
        captured = now_ns()
        out: list[Matchup] = []
        for m in result["matchups"]:
            ml = [
                MoneylineSelection(team=x["team"], side="", decimal=float(x["decimal"]), source_tier=DetectionTier.NETWORK_WS, captured_ns=captured)
                for x in m.get("ml", [])
            ]
            if len(ml) < 1:
                continue
            out.append(
                Matchup(
                    site=SiteId.BC_GAME,
                    event_id=f"{m['home']}|{m['away']}".lower(),
                    home=m["home"],
                    away=m["away"],
                    moneyline=ml,
                    source_tier=DetectionTier.NETWORK_WS,
                    captured_ns=captured,
                )
            )
        self._matchups = out
        return out
