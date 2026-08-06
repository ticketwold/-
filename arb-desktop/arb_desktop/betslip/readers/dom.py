from __future__ import annotations

from playwright.async_api import Frame, Page

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult
from arb_desktop.betslip.readers import load_js

BC_SITE_LABEL = "BC.Game"
BTI_SITE_LABEL = "x10x10s"

BC_FRAME_HINTS = ("betby.com", "sptpub.com", "sptsportscdn", "biahosted", "cocoesports", "bc.game")
BTI_FRAME_HINTS = ("bti", "sportsbook", "x10x10s", "sports")


def _frame_score(url: str, hints: tuple[str, ...]) -> int:
    u = url.lower()
    score = 0
    for hint in hints:
        if hint in u:
            score += 100
    return score


def _parse_result(site: str, payload: dict | None, frame_url: str) -> BetSlipReadResult:
    if not payload:
        return BetSlipReadResult(site=site, ok=False, empty=True, reason="evaluate-failed", frame_url=frame_url)

    items = [BetSlipItem.from_dict(site, item) for item in payload.get("items") or []]
    return BetSlipReadResult(
        site=site,
        ok=bool(payload.get("ok")),
        empty=bool(payload.get("empty", not items)),
        items=items,
        frame_url=frame_url,
        source=str(payload.get("source") or "dom"),
        reason=str(payload.get("reason") or ""),
        raw=payload,
    )


def _pick_best(results: list[BetSlipReadResult]) -> BetSlipReadResult:
    if not results:
        return BetSlipReadResult(site="", ok=False, empty=True, reason="no-frames")

    def score(r: BetSlipReadResult) -> tuple[int, int]:
        item = r.first
        has_item = 1 if item and (item.event or item.selection) else 0
        has_odds = 1 if item and item.odds else 0
        return (has_item + has_odds, len(r.items))

    return max(results, key=score)


async def _read_in_frames(page: Page, js_name: str, site: str, hints: tuple[str, ...]) -> BetSlipReadResult:
    js = load_js(js_name)
    frames: list[Frame] = sorted(page.frames, key=lambda f: _frame_score(f.url, hints), reverse=True)
    results: list[BetSlipReadResult] = []

    for frame in frames:
        try:
            payload = await frame.evaluate(js)
        except Exception:
            continue
        result = _parse_result(site, payload, frame.url[:160])
        results.append(result)
        if result.ok and not result.empty and result.first and (result.first.event or result.first.selection):
            if result.first.odds is not None:
                return result

    return _pick_best(results) if results else BetSlipReadResult(site=site, ok=False, empty=True, reason="no-readable-frame")


async def read_bc_betslip(page: Page) -> BetSlipReadResult:
    return await _read_in_frames(page, "bc_slip_reader.js", BC_SITE_LABEL, BC_FRAME_HINTS)


async def read_bti_betslip(page: Page) -> BetSlipReadResult:
    return await _read_in_frames(page, "bti_slip_reader.js", BTI_SITE_LABEL, BTI_FRAME_HINTS)
