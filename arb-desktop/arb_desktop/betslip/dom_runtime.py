from __future__ import annotations

from playwright.async_api import Frame, Page

from arb_desktop.betslip.execution_models import LocatorCacheEntry, OverlayState
from arb_desktop.betslip.locator_cache import StableLocatorCache
from arb_desktop.betslip.readers import load_js

BC_FRAME_HINTS = ("betby.com", "sptpub.com", "sptsportscdn", "bc.game")
BTI_FRAME_HINTS = ("bti", "sportsbook", "x10x10s", "sportscenter", "sports")


def _score(url: str, hints: tuple[str, ...]) -> int:
    u = url.lower()
    return sum(100 for h in hints if h in u)


async def _best_frame(page: Page, hints: tuple[str, ...]) -> Frame | None:
    frames = sorted(page.frames, key=lambda f: _score(f.url, hints), reverse=True)
    return frames[0] if frames else None


async def inject_monitor(page: Page, hints: tuple[str, ...]) -> str:
    js = load_js("dom_monitor.js")
    frame = await _best_frame(page, hints)
    if not frame:
        return ""
    try:
        await frame.evaluate(js)
        state = await frame.evaluate("() => window.__arbSlipMonitor?.getState?.() || {}")
        return str(state.get("hash", ""))
    except Exception:
        return ""


async def get_dom_hash(page: Page, hints: tuple[str, ...]) -> str:
    frame = await _best_frame(page, hints)
    if not frame:
        return ""
    try:
        return await frame.evaluate("() => window.__arbSlipMonitor?.computeHash?.() || ''")
    except Exception:
        return ""


async def setup_monitors(bc_page: Page, bti_page: Page) -> tuple[str, str]:
    bc_hash = await inject_monitor(bc_page, BC_FRAME_HINTS)
    bti_hash = await inject_monitor(bti_page, BTI_FRAME_HINTS)
    return bc_hash, bti_hash


async def update_overlay(page: Page, state: OverlayState, hints: tuple[str, ...]) -> None:
    js = load_js("overlay.js")
    payload = {
        "bc_status": state.bc_status,
        "bc_odds": state.bc_odds,
        "bti_status": state.bti_status,
        "bti_odds": state.bti_odds,
        "profit": state.profit,
        "match_ok": state.match_ok,
        "network_ok": state.network_ok,
        "dom_ok": state.dom_ok,
        "lock_ok": state.lock_ok,
        "stage": state.stage,
    }
    for frame in sorted(page.frames, key=lambda f: _score(f.url, hints), reverse=True):
        try:
            await frame.evaluate(f"({js})", payload)
            return
        except Exception:
            continue


async def set_stake_in_page(
    page: Page,
    *,
    site: str,
    amount: float,
    hints: tuple[str, ...],
    cache: StableLocatorCache,
    container_selector: str = "",
    max_retries: int = 3,
) -> dict:
    js = load_js("stake_input.js")
    site_key = "BC.Game" if site == "bc" else "x10x10s"
    last: dict = {"ok": False, "reason": "no-frame"}

    for attempt in range(max_retries):
        dom_hash = await get_dom_hash(page, hints)
        if cache.should_refresh(site_key, dom_hash):
            cache.invalidate(site_key)

        cached = cache.get(site_key)
        stake_selector = ""
        if cached and cached.dom_hash == dom_hash:
            stake_selector = cached.stake_selector

        frame = await _best_frame(page, hints)
        if not frame:
            last = {"ok": False, "reason": "no-frame", "attempt": attempt}
            continue

        try:
            await frame.evaluate(load_js("dom_monitor.js"))
            result = await frame.evaluate(
                f"({js})",
                {
                    "site": site,
                    "amount": amount,
                    "containerSelector": container_selector,
                    "stakeSelector": stake_selector,
                    "tolerance": 0.0,
                },
            )
            last = dict(result or {})
            last["attempt"] = attempt
            last["dom_hash"] = dom_hash
            if result and result.get("ok"):
                cache.put(
                    LocatorCacheEntry(
                        site=site_key,
                        frame_url=frame.url[:200],
                        container_selector=container_selector,
                        stake_selector=str(result.get("selector", "")),
                        dom_hash=dom_hash,
                    )
                )
                return last
        except Exception as exc:
            last = {"ok": False, "reason": str(exc), "attempt": attempt}
            cache.invalidate(site_key)

    return last


async def read_stake_in_page(
    page: Page,
    *,
    site: str,
    hints: tuple[str, ...],
    container_selector: str = "",
) -> float:
    frame = await _best_frame(page, hints)
    if not frame:
        return 0.0
    try:
        val = await frame.evaluate(
            """(args) => {
              const site = args.site;
              const root = args.containerSelector
                ? document.querySelector(args.containerSelector)
                : document.querySelector('[data-editor-id*="betslip"], [class*="betslip"]');
              const scope = root || document;
              const el = site === 'bti'
                ? scope.querySelector('input#counter, input[class*="Counter"]')
                : scope.querySelector('[data-editor-id*="betslipStake"], [role="spinbutton"] input, [role="spinbutton"]');
              if (!el) return 0;
              const raw = String(el.value || el.textContent || '').replace(/,/g,'');
              const n = parseFloat(raw);
              return Number.isFinite(n) ? n : 0;
            }""",
            {"site": site, "containerSelector": container_selector},
        )
        return float(val or 0)
    except Exception:
        return 0.0
