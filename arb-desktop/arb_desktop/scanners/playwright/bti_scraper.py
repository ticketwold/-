from __future__ import annotations

from playwright.async_api import Frame, Page

from arb_desktop.models import DetectionTier, Matchup, MoneylineSelection, SiteId
from arb_desktop.scanners.tiers import PlaywrightScanner
from arb_desktop.timing import now_ns

BTI_BOARD_JS = """
() => {
  const events = [];
  const seen = new Set();
  function oddsFrom(el) {
    const t = (el.textContent||'').replace(/\\s+/g,' ').trim();
    const m = t.match(/(\\d+\\.\\d{2,3})/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return n > 1.01 && n < 100 ? n : null;
  }
  for (const btn of document.querySelectorAll('button.master_fe_Selections_selection, [class*="Selections_selection"], [class*="Outcome"]')) {
    const o = oddsFrom(btn);
    if (!o) continue;
    let row = btn.closest('[class*="event"], [class*="Event"], [class*="match"]') || btn.parentElement?.parentElement;
    const txt = (row?.textContent || btn.textContent || '').replace(/\\s+/g,' ').trim();
    const m = txt.match(/([A-Za-z0-9가-힣][^\\n]{1,40}?)\\s+vs\\.?\\s+([A-Za-z0-9가-힣][^\\n]{1,40})/i);
    if (!m) continue;
    const home = m[1].trim(), away = m[2].trim();
    const key = home+'|'+away;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ home, away, odds: o, label: (btn.textContent||'').trim().slice(0,80) });
  }
  return { events, count: events.length };
}
"""


class BtiDomScanner(PlaywrightScanner):
    """2순위: Playwright DOM — BTI iframe 배당판."""

    def __init__(self, page: Page | None):
        self._page = page

    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        if not self._page:
            return [], "BTI page not ready"

        best_events: list[dict] = []
        best_count = 0
        frames: list[Frame] = list(self._page.frames)
        for frame in frames:
            try:
                result = await frame.evaluate(BTI_BOARD_JS)
                count = result.get("count", 0) if result else 0
                if count > best_count:
                    best_count = count
                    best_events = result.get("events", [])
            except Exception:
                continue

        if not best_events:
            return [], f"BTI DOM: 0 events in {len(frames)} frames"

        captured = now_ns()
        grouped: dict[str, Matchup] = {}
        for ev in best_events:
            key = f"{ev['home']}|{ev['away']}".lower()
            if key not in grouped:
                grouped[key] = Matchup(
                    site=SiteId.BTI_X10,
                    event_id=key,
                    home=ev["home"],
                    away=ev["away"],
                    source_tier=self.tier,
                    captured_ns=captured,
                )
            grouped[key].moneyline.append(
                MoneylineSelection(
                    team=ev.get("label", ev["home"]),
                    side="home" if len(grouped[key].moneyline) == 0 else "away",
                    decimal=float(ev["odds"]),
                    source_tier=self.tier,
                    captured_ns=captured,
                )
            )

        matchups = [m for m in grouped.values() if len(m.moneyline) >= 1]
        return matchups, f"BTI DOM {len(matchups)} matchups ({best_count} buttons)"
