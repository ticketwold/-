from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

import httpx
import orjson

from arb_desktop.config import settings
from arb_desktop.core.sptpub_v4_parser import (
    is_sptpub_v4_url,
    parse_sptpub_v4_matchups,
    sptpub_feed_from_url,
)
from arb_desktop.models import DetectionTier, Matchup
from arb_desktop.scanners.tiers import NetworkScanner


class SptpubV4Client(NetworkScanner):
    """sptpub /api/v4/live + /api/v4/prematch 직접 fetch."""

    tier = DetectionTier.NETWORK_HTTP

    def __init__(self) -> None:
        self._base_url: str | None = None
        self._cookies: httpx.Cookies = httpx.Cookies()
        self._client: httpx.AsyncClient | None = None
        self._last_message = "sptpub base URL not set"

    def set_session(self, base_url: str, cookies: httpx.Cookies | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        if cookies:
            self._cookies = cookies

    async def discover_base_from_page(self, page) -> str | None:
        """BC 페이지 iframe / network 에서 sptpub origin 추출."""
        candidates: list[str] = []
        for frame in page.frames:
            u = frame.url or ""
            if "sptpub" in u.lower():
                p = urlparse(u)
                candidates.append(f"{p.scheme}://{p.netloc}")

        # 페이지 내 script/src 검색
        try:
            urls = await page.evaluate(
                """() => {
                  const out = [];
                  for (const el of document.querySelectorAll('iframe, script, link')) {
                    const u = el.src || el.href || '';
                    if (/sptpub/i.test(u)) out.push(u);
                  }
                  return out;
                }"""
            )
            for u in urls or []:
                if "sptpub" in u.lower():
                    p = urlparse(u)
                    candidates.append(f"{p.scheme}://{p.netloc}")
        except Exception:
            pass

        if candidates:
            self._base_url = candidates[0]
            return self._base_url
        return None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                cookies=self._cookies,
                timeout=settings.network_timeout_ms / 1000,
                follow_redirects=True,
                headers={
                    "Accept": "application/json, text/plain, */*",
                    "Origin": "https://bc.game",
                    "Referer": "https://bc.game/",
                },
            )
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    def _endpoints(self) -> list[tuple[str, str]]:
        if not self._base_url:
            return []
        return [
            (f"{self._base_url}/api/v4/live", "live"),
            (f"{self._base_url}/api/v4/prematch", "prematch"),
        ]

    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        if not self._base_url:
            return [], "sptpub base URL missing — open BC sports first"

        client = await self._ensure_client()
        all_matchups: dict[str, Matchup] = {}
        feeds_ok: list[str] = []

        for url, feed in self._endpoints():
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    self._last_message = f"{feed}: HTTP {resp.status_code}"
                    continue
                data = orjson.loads(resp.content)
                matchups = parse_sptpub_v4_matchups(data, feed=feed, tier=self.tier)
                if matchups:
                    feeds_ok.append(f"{feed}={len(matchups)}")
                for m in matchups:
                    key = m.event_id or f"{m.home}|{m.away}".lower()
                    if key not in all_matchups or len(m.moneyline) > len(all_matchups[key].moneyline):
                        all_matchups[key] = m
            except Exception as exc:
                self._last_message = f"{feed} error: {exc}"
                continue

        result = list(all_matchups.values())
        if result:
            self._last_message = f"sptpub v4 [{', '.join(feeds_ok)}] total {len(result)}"
        return result, self._last_message

    @staticmethod
    def parse_cdp_payload(raw: str | bytes, url: str) -> list[Matchup]:
        if not is_sptpub_v4_url(url):
            return []
        feed = sptpub_feed_from_url(url)
        try:
            data = orjson.loads(raw) if isinstance(raw, (str, bytes)) else raw
        except orjson.JSONDecodeError:
            return []
        return parse_sptpub_v4_matchups(data, feed=feed, tier=DetectionTier.NETWORK_WS)
