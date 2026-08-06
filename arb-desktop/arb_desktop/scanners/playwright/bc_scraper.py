from __future__ import annotations

from playwright.async_api import Frame, Page

from arb_desktop.models import DetectionTier, Matchup, MoneylineSelection, SiteId
from arb_desktop.scanners.network.bc_cdp_tap import BC_BOARD_JS
from arb_desktop.scanners.tiers import PlaywrightScanner
from arb_desktop.timing import now_ns

BETBY_HOST_RE = ("betby.com", "sptpub.com", "sptsportscdn", "biahosted", "cocoesports")


class BcDomScanner(PlaywrightScanner):
    """2순위: Playwright DOM — BetBy iframe 배당판 (selector 다중화)."""

    def __init__(self, page: Page | None):
        self._page = page

    def _score_frame(self, url: str) -> int:
        u = url.lower()
        if any(h in u for h in BETBY_HOST_RE):
            return 100
        if "bc.game" in u and "sports" in u:
            return 80
        return 5

    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        if not self._page:
            return [], "BC page not ready"

        frames = sorted(self._page.frames, key=lambda f: self._score_frame(f.url), reverse=True)
        best: list[dict] = []
        best_count = 0
        used_url = ""

        for frame in frames:
            try:
                result = await frame.evaluate(BC_BOARD_JS)
                count = len(result.get("matchups", [])) if result else 0
                if count > best_count:
                    best_count = count
                    best = result.get("matchups", [])
                    used_url = frame.url[:80]
            except Exception:
                continue

        if not best:
            return [], f"BC DOM: 0 matchups in {len(frames)} frames"

        captured = now_ns()
        matchups: list[Matchup] = []
        for m in best:
            ml = [
                MoneylineSelection(
                    team=x["team"],
                    side="",
                    decimal=float(x["decimal"]),
                    source_tier=self.tier,
                    captured_ns=captured,
                )
                for x in m.get("ml", [])
            ]
            if not ml:
                continue
            matchups.append(
                Matchup(
                    site=SiteId.BC_GAME,
                    event_id=f"{m['home']}|{m['away']}".lower(),
                    home=m["home"],
                    away=m["away"],
                    moneyline=ml,
                    source_tier=self.tier,
                    captured_ns=captured,
                )
            )

        return matchups, f"BC DOM {len(matchups)} matchups @ {used_url}"
