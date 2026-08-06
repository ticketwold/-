from __future__ import annotations

import asyncio
import base64
from typing import Any

import orjson
from playwright.async_api import Page

from arb_desktop.config import settings
from arb_desktop.scanners.playwright.session import BrowserSession
from arb_desktop.validation.api_reader import events_from_cdp_payload, fetch_live_api_events
from arb_desktop.validation.matcher import LiveVerifyLogger, match_events
from arb_desktop.validation.models import LiveVerifyReport, VerifyEvent
from arb_desktop.validation.screen_reader import scrape_screen_events


class CdpLiveApiCapture:
    """CDP로 /api/v4/live 응답 캡처 (HTTP fetch 실패 시 fallback)."""

    def __init__(self) -> None:
        self._payload: bytes | None = None
        self._url: str = ""
        self._cdp = None

    @property
    def has_payload(self) -> bool:
        return self._payload is not None

    async def attach(self, page: Page) -> None:
        self._cdp = await page.context.new_cdp_session(page)
        await self._cdp.send("Network.enable")

        def on_response(params: dict) -> None:
            try:
                url = params.get("response", {}).get("url", "")
                if "/api/v4/live" not in url.lower() or "sptpub" not in url.lower():
                    return
                rid = params.get("requestId")
                if rid:
                    asyncio.create_task(self._read(rid, url))
            except Exception:
                pass

        self._cdp.on("Network.responseReceived", on_response)

    async def _read(self, request_id: str, url: str) -> None:
        try:
            body = await self._cdp.send("Network.getResponseBody", {"requestId": request_id})
            raw = body.get("body", "")
            if body.get("base64Encoded"):
                raw = base64.b64decode(raw)
            elif isinstance(raw, str):
                raw = raw.encode()
            self._payload = raw
            self._url = url
        except Exception:
            pass

    def to_events(self, *, ml_only: bool = True) -> list[VerifyEvent]:
        if not self._payload:
            return []
        return events_from_cdp_payload(self._payload, self._url, ml_only=ml_only)


async def run_live_verification(
    session: BrowserSession,
    *,
    wait_ms: int = 12_000,
    odds_tolerance: float = 0.03,
    logger: LiveVerifyLogger | None = None,
) -> LiveVerifyReport:
    page = session.bc_page
    if not page:
        raise RuntimeError("BC page not initialized")

    cdp_capture = CdpLiveApiCapture()
    await cdp_capture.attach(page)

    # 라이브 탭으로 이동 (이미 sports면 스크롤만)
    try:
        live_url = settings.bc_sports_url.rstrip("/") + "/live"
        if "live" not in (page.url or "").lower():
            await page.goto(live_url, wait_until="domcontentloaded", timeout=30_000)
    except Exception:
        pass

    await session.wait_for_frames(page, wait_ms)
    await asyncio.sleep(2.0)  # BetBy iframe + API 로드 대기

    # sptpub 세션
    await session.sptpub_client.discover_base_from_page(page)
    if session._context and session.sptpub_client._base_url:
        import httpx

        jar = httpx.Cookies()
        for c in await session._context.cookies():
            jar.set(c["name"], c["value"], domain=c.get("domain", "").lstrip("."), path=c.get("path", "/"))
        session.sptpub_client.set_session(session.sptpub_client._base_url, jar)

    # API
    api_events, api_msg, _ = await fetch_live_api_events(session.sptpub_client)
    api_source = api_msg

    if not api_events and cdp_capture.has_payload:
        api_events = cdp_capture.to_events()
        api_source = f"CDP capture {cdp_capture._url[:80]} ({len(api_events)} events)"

    # SCREEN
    screen_events, screen_msg = await scrape_screen_events(page)

    report = match_events(api_events, screen_events, odds_tolerance=odds_tolerance)
    report.api_source = api_source
    report.screen_source = screen_msg

    log = logger or LiveVerifyLogger()
    log.log_report(report)

    return report


async def main_async() -> int:
    session = BrowserSession()
    try:
        await session.start()
        report = await run_live_verification(session)
        return 0 if report.matched_count > 0 and report.failed_count == 0 else 1
    finally:
        await session.stop()


def main() -> None:
    raise SystemExit(asyncio.run(main_async()))
