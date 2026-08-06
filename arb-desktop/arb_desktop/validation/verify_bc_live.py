from __future__ import annotations

import asyncio
import base64
import sys
from time import monotonic

import orjson
from playwright.async_api import Page

from arb_desktop.config import settings
from arb_desktop.scanners.playwright.session import BrowserSession
from arb_desktop.validation.api_reader import events_from_payload_candidate, fetch_feed_api_events
from arb_desktop.validation.matcher import LiveVerifyLogger, match_events
from arb_desktop.validation.models import LiveVerifyReport
from arb_desktop.validation.screen_reader import scrape_screen_events, wait_for_screen_events
from arb_desktop.validation.sptpub_payload import (
    PayloadCandidate,
    analyze_payload,
    is_sptpub_feed_url,
    select_with_fallback,
)


class VerifyDebugLogger:
    def __init__(self, stream=None):
        self._out = stream or sys.stdout

    def line(self, msg: str = "") -> None:
        print(msg, file=self._out, flush=True)

    def log_page_state(self, page: Page) -> None:
        self.line("[DEBUG] --- Page / Frames ---")
        self.line(f"  page URL: {page.url}")
        for i, frame in enumerate(page.frames):
            self.line(f"  frame[{i}]: {frame.url[:120]}")

    def log_candidates(self, candidates: list[PayloadCandidate]) -> None:
        self.line("[DEBUG] --- sptpub Response Candidates ---")
        if not candidates:
            self.line("  (none captured)")
            return
        for i, c in enumerate(candidates):
            self.line(
                f"  [{i}] feed={c.feed} events={c.event_count} parsed={c.parsed_event_count} "
                f"markets={c.market_count} sel={c.selection_count} ver={c.version} "
                f"init={c.is_init_url} score={c.score:.1f}"
            )
            self.line(f"       keys={c.top_keys}")
            self.line(f"       url={c.url[:140]}")

    def log_selected(self, selected: PayloadCandidate | None, feed_label: str) -> None:
        self.line("[DEBUG] --- Selected Payload ---")
        if not selected:
            self.line("  (none)")
            return
        self.line(f"  feed: {feed_label}")
        self.line(f"  url: {selected.url}")
        self.line(f"  top-level keys: {selected.top_keys}")
        self.line(
            f"  event_count={selected.event_count} parsed={selected.parsed_event_count} "
            f"version={selected.version} generated={selected.generated or '-'}"
        )


class CdpSptpubCollector:
    """CDP: /api/v4/live + prematch 응답 전부 수집."""

    def __init__(self) -> None:
        self.candidates: list[PayloadCandidate] = []
        self._cdp = None
        self._seen_urls: set[str] = set()

    async def attach(self, page: Page) -> None:
        self._cdp = await page.context.new_cdp_session(page)
        await self._cdp.send("Network.enable")

        def on_response(params: dict) -> None:
            try:
                url = params.get("response", {}).get("url", "")
                if not is_sptpub_feed_url(url):
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

            # 동일 URL 최신본 유지 (짧은 dedupe window)
            dedupe_key = url.split("?")[0]
            candidate = analyze_payload(url, raw)
            if not candidate:
                return
            self.candidates = [c for c in self.candidates if c.url.split("?")[0] != dedupe_key]
            self.candidates.append(candidate)
        except Exception:
            pass

    def best(self) -> tuple[PayloadCandidate | None, str]:
        return select_with_fallback(self.candidates)


async def _interactive_wait(page: Page, seconds: int, dbg: VerifyDebugLogger) -> None:
    dbg.line()
    dbg.line(f"[WAIT] {seconds}초 — Chromium에서 BC.Game 스포츠/라이브 탭을 직접 클릭하세요")
    dbg.line("       (창을 닫지 마세요. CDP가 API 응답을 수집 중입니다)")
    dbg.log_page_state(page)
    deadline = monotonic() + seconds
    while monotonic() < deadline:
        remaining = int(deadline - monotonic())
        if remaining % 10 == 0 or remaining <= 5:
            dbg.line(f"  ... {remaining}s 남음 | frames={len(page.frames)}")
        await asyncio.sleep(1.0)


async def run_live_verification(
    session: BrowserSession,
    *,
    user_wait_sec: int = 60,
    screen_wait_sec: int = 30,
    keep_open_sec: int = 60,
    odds_tolerance: float = 0.03,
    logger: LiveVerifyLogger | None = None,
    dbg: VerifyDebugLogger | None = None,
) -> LiveVerifyReport:
    page = session.bc_page
    if not page:
        raise RuntimeError("BC page not initialized")

    dbg = dbg or VerifyDebugLogger()
    cdp = CdpSptpubCollector()
    await cdp.attach(page)

    # 초기 sports 페이지 (강제 live 이동 X — 사용자가 직접 클릭)
    try:
        if "bc.game" not in (page.url or "").lower():
            await page.goto(settings.bc_sports_url, wait_until="domcontentloaded", timeout=30_000)
    except Exception:
        pass

    await session.wait_for_frames(page, 8_000)

    # 60초 사용자 대기 (CDP 수집 병행)
    await _interactive_wait(page, user_wait_sec, dbg)

    # sptpub 세션 + HTTP fetch도 시도
    await session.sptpub_client.discover_base_from_page(page)
    if session._context and session.sptpub_client._base_url:
        import httpx

        jar = httpx.Cookies()
        for c in await session._context.cookies():
            jar.set(c["name"], c["value"], domain=c.get("domain", "").lstrip("."), path=c.get("path", "/"))
        session.sptpub_client.set_session(session.sptpub_client._base_url, jar)

        for feed in ("live", "prematch"):
            events, msg, raw = await fetch_feed_api_events(session.sptpub_client, feed=feed)
            if raw:
                url = f"{session.sptpub_client._base_url}/api/v4/{feed}"
                cand = analyze_payload(url, orjson.dumps(raw))
                if cand:
                    cdp.candidates.append(cand)
            dbg.line(f"[DEBUG] HTTP fetch {feed}: {msg}")

    dbg.log_candidates(cdp.candidates)
    selected, feed_label = cdp.best()
    dbg.log_selected(selected, feed_label)

    # API events
    api_events: list = []
    api_source = "no payload"
    if selected:
        api_events = events_from_payload_candidate(selected)
        api_source = f"{feed_label} @ {selected.url[:90]} ({len(api_events)} parsed events)"

    # BetBy iframe DOM — 경기 카드 1개 이상 나올 때까지 대기
    dbg.line()
    dbg.line(f"[WAIT] 화면 경기 로드 대기 (최대 {screen_wait_sec}초)...")
    screen_events, screen_msg = await wait_for_screen_events(page, timeout_sec=screen_wait_sec)
    dbg.line(f"[DEBUG] screen: {screen_msg}")
    dbg.log_page_state(page)

    report = match_events(api_events, screen_events, odds_tolerance=odds_tolerance)
    report.api_source = api_source
    report.screen_source = screen_msg

    log = logger or LiveVerifyLogger(print_fn=dbg.line)
    log.log_report(report)

    if keep_open_sec > 0:
        dbg.line()
        dbg.line(f"[WAIT] 결과 확인 후 {keep_open_sec}초 뒤 브라우저 종료...")
        await asyncio.sleep(keep_open_sec)

    return report


async def main_async(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="BC.Game 라이브 API vs 화면 검증")
    parser.add_argument("--wait", type=int, default=60, help="사용자 탭 클릭 대기(초)")
    parser.add_argument("--screen-wait", type=int, default=30, help="화면 경기 로드 대기(초)")
    parser.add_argument("--keep-open", type=int, default=60, help="종료 전 브라우저 유지(초)")
    parser.add_argument("--no-keep-open", action="store_true", help="검증 후 즉시 종료")
    args = parser.parse_args(argv)

    session = BrowserSession()
    try:
        await session.start()
        report = await run_live_verification(
            session,
            user_wait_sec=args.wait,
            screen_wait_sec=args.screen_wait,
            keep_open_sec=0 if args.no_keep_open else args.keep_open,
        )
        ok = report.matched_count > 0
        return 0 if ok else 1
    finally:
        await session.stop()


def main() -> None:
    raise SystemExit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
