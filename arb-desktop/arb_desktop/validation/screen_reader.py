from __future__ import annotations

import asyncio
from time import monotonic

from arb_desktop.scanners.network.bc_cdp_tap import BC_BOARD_JS
from arb_desktop.scanners.playwright.bc_scraper import BETBY_HOST_RE
from arb_desktop.validation.models import TeamOdds, VerifyEvent
from playwright.async_api import Page

# 경기 카드/배당 버튼 존재 probe
SCREEN_READY_JS = """
() => {
  const sels = [
    '[data-editor-id*="outcome"]', '[data-editor-id*="OddsButton"]',
    'button[data-editor-id]', '[class*="Outcome"]', '[class*="Selection"]',
    'button.master_fe_Selections_selection'
  ];
  let buttons = 0;
  for (const sel of sels) {
    buttons += document.querySelectorAll(sel).length;
  }
  const vs = (document.body?.innerText || '').match(/\\bvs\\.?\\b/gi);
  return { buttons, vsCount: vs ? vs.length : 0, textLen: (document.body?.innerText || '').length };
}
"""


async def wait_for_screen_events(
    page: Page | None,
    *,
    timeout_sec: int = 30,
    poll_ms: int = 500,
) -> tuple[list[VerifyEvent], str]:
    """BetBy iframe에서 경기 카드 1개 이상 나타날 때까지 대기 후 스크랩."""
    if not page:
        return [], "BC page 없음"

    deadline = monotonic() + timeout_sec
    last_probe = ""
    while monotonic() < deadline:
        events, msg = await scrape_screen_events(page)
        if events:
            return events, f"{msg} (waited {timeout_sec - int(deadline - monotonic())}s)"

        # probe best frame
        frames = sorted(page.frames, key=lambda f: _score_frame(f.url), reverse=True)
        for frame in frames:
            try:
                probe = await frame.evaluate(SCREEN_READY_JS)
                last_probe = f"frame={frame.url[:60]} buttons={probe.get('buttons')} vs={probe.get('vsCount')}"
            except Exception:
                continue

        await asyncio.sleep(poll_ms / 1000)

    events, msg = await scrape_screen_events(page)
    if events:
        return events, msg
    return [], f"화면 0경기 ({len(page.frames)} frames, timeout {timeout_sec}s) [{last_probe}]"


async def scrape_screen_events(page: Page | None) -> tuple[list[VerifyEvent], str]:
    """BC.Game 라이브 화면에서 경기명 + 배당 추출."""
    if not page:
        return [], "BC page 없음"

    frames = sorted(
        page.frames,
        key=lambda f: _score_frame(f.url),
        reverse=True,
    )

    best_matchups: list[dict] = []
    best_count = 0
    used_url = ""

    for frame in frames:
        try:
            result = await frame.evaluate(BC_BOARD_JS)
            count = len(result.get("matchups", [])) if result else 0
            if count > best_count:
                best_count = count
                best_matchups = result.get("matchups", [])
                used_url = frame.url[:100]
        except Exception:
            continue

    if not best_matchups:
        return [], f"화면 0경기 ({len(frames)} frames)"

    events: list[VerifyEvent] = []
    for m in best_matchups:
        home = (m.get("home") or "").strip()
        away = (m.get("away") or "").strip()
        if not home or not away:
            continue
        ml = m.get("ml") or []
        if not ml:
            continue
        events.append(
            VerifyEvent(
                event_id=f"{home}|{away}".lower(),
                home=home,
                away=away,
                title=f"{home} vs {away}",
                odds=[
                    TeamOdds(
                        team=x.get("team", ""),
                        decimal=float(x.get("decimal", 0)),
                        market="screen-ml",
                        source="screen",
                    )
                    for x in ml
                    if x.get("team") and x.get("decimal")
                ],
                feed="screen",
            )
        )

    return events, f"화면 {len(events)}경기 @ {used_url}"


def _score_frame(url: str) -> int:
    u = (url or "").lower()
    if any(h in u for h in BETBY_HOST_RE):
        return 100
    if "bc.game" in u and "sports" in u:
        return 80
    return 5
