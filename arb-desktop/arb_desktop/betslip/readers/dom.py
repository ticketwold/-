from __future__ import annotations

import asyncio
from time import monotonic

from playwright.async_api import Frame, Page

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult
from arb_desktop.betslip.readers import load_js

BC_SITE_LABEL = "BC.Game"
BTI_SITE_LABEL = "x10x10s"

BC_FRAME_HINTS = ("betby.com", "sptpub.com", "sptsportscdn", "biahosted", "cocoesports", "bc.game")
BTI_FRAME_HINTS = ("bti", "sportsbook", "x10x10s", "sportscenter", "sports")


def _frame_score(url: str, hints: tuple[str, ...]) -> int:
    u = url.lower()
    return sum(100 for hint in hints if hint in u)


def _wrap_js(js: str, *, debug: bool = False) -> str:
    return f"({js})({{debug: {str(debug).lower()}}})"


def _parse_result(site: str, payload: dict | None, frame_url: str) -> BetSlipReadResult:
    if not payload:
        return BetSlipReadResult(site=site, ok=False, empty=True, reason="evaluate-failed", frame_url=frame_url)

    container_selector = str(payload.get("container_selector") or "")
    source = str(payload.get("source") or "dom")
    items = [
        BetSlipItem.from_dict(
            site,
            item,
            frame_url=str(item.get("frame_url") or frame_url),
            source=source,
            container_selector=str(item.get("container_selector") or container_selector),
        )
        for item in (payload.get("items") or [])
    ]
    return BetSlipReadResult(
        site=site,
        ok=bool(payload.get("ok")),
        empty=bool(payload.get("empty", not items)),
        items=items,
        frame_url=frame_url,
        source=source,
        container_selector=container_selector,
        reason=str(payload.get("reason") or ""),
        raw=payload,
    )


def _pick_best(results: list[BetSlipReadResult]) -> BetSlipReadResult:
    if not results:
        return BetSlipReadResult(site="", ok=False, empty=True, reason="no-frames")

    def score(r: BetSlipReadResult) -> tuple[int, int, int]:
        item = r.first
        has_item = 1 if item and (item.event or item.selection) else 0
        has_odds = 1 if item and item.odds else 0
        not_empty = 0 if r.empty else 1
        return (not_empty + has_item + has_odds, has_odds, len(r.items))

    return max(results, key=score)


def list_frame_urls(page: Page) -> list[str]:
    return [f.url for f in page.frames]


async def _read_bc_in_frames(page: Page, *, debug: bool = False) -> tuple[BetSlipReadResult, list[dict]]:
    js = _wrap_js(load_js("bc_slip_reader.js"), debug=debug)
    frames: list[Frame] = sorted(page.frames, key=lambda f: _frame_score(f.url, BC_FRAME_HINTS), reverse=True)
    results: list[BetSlipReadResult] = []
    debug_blocks: list[dict] = []

    for frame in frames:
        try:
            payload = await frame.evaluate(js)
        except Exception:
            continue
        if payload and payload.get("debug"):
            debug_blocks.extend(payload.get("debug") or [])
        result = _parse_result(BC_SITE_LABEL, payload, frame.url[:200])
        results.append(result)
        if result.ok and not result.empty and result.first and (result.first.event or result.first.selection):
            if result.first.odds is not None:
                return result, debug_blocks

    best = _pick_best(results) if results else BetSlipReadResult(site=BC_SITE_LABEL, ok=False, empty=True, reason="no-readable-frame")
    return best, debug_blocks


async def _read_bti_in_frames(page: Page, *, debug: bool = False) -> tuple[BetSlipReadResult, list[dict]]:
    js = _wrap_js(load_js("bti_slip_reader.js"), debug=debug)
    frames: list[Frame] = sorted(page.frames, key=lambda f: _frame_score(f.url, BTI_FRAME_HINTS), reverse=True)
    results: list[BetSlipReadResult] = []
    frame_probes: list[dict] = []

    for frame in frames:
        try:
            payload = await frame.evaluate(js)
        except Exception:
            continue
        if payload:
            frame_probes.append(
                {
                    "frame_url": frame.url[:200],
                    "can_scan": payload.get("can_scan"),
                    "empty": payload.get("empty"),
                    "reason": payload.get("reason"),
                    "probes": payload.get("probes") or [],
                }
            )
        result = _parse_result(BTI_SITE_LABEL, payload, frame.url[:200])
        results.append(result)
        if result.ok and not result.empty and result.first and (result.first.event or result.first.selection):
            result.raw["frame_probes"] = frame_probes
            return result, frame_probes

    best = _pick_best(results) if results else BetSlipReadResult(site=BTI_SITE_LABEL, ok=False, empty=True, reason="no-readable-frame")
    best.raw["frame_probes"] = frame_probes
    return best, frame_probes


async def wait_for_bti_cart(page: Page, *, timeout_sec: float = 30.0, poll_sec: float = 0.5, debug: bool = False) -> BetSlipReadResult:
    deadline = monotonic() + timeout_sec
    last = BetSlipReadResult(site=BTI_SITE_LABEL, ok=False, empty=True, reason="cart-wait-timeout")
    while monotonic() < deadline:
        result, probes = await _read_bti_in_frames(page, debug=debug)
        last = result
        last.raw["frame_probes"] = probes
        if not result.empty and result.first and (result.first.event or result.first.selection):
            return result
        await asyncio.sleep(poll_sec)
    return last


async def read_bc_betslip(page: Page, *, debug: bool = False) -> BetSlipReadResult:
    result, debug_blocks = await _read_bc_in_frames(page, debug=debug)
    if debug_blocks:
        result.raw["debug"] = debug_blocks
    return result


async def read_bti_betslip(page: Page, *, debug: bool = False, wait_sec: float = 30.0) -> BetSlipReadResult:
    if wait_sec > 0:
        return await wait_for_bti_cart(page, timeout_sec=wait_sec, debug=debug)
    result, probes = await _read_bti_in_frames(page, debug=debug)
    result.raw["frame_probes"] = probes
    return result
