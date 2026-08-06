from __future__ import annotations

from arb_desktop.scanners.network.bc_cdp_tap import BC_BOARD_JS
from arb_desktop.scanners.playwright.bc_scraper import BETBY_HOST_RE
from arb_desktop.validation.models import TeamOdds, VerifyEvent
from playwright.async_api import Page


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
