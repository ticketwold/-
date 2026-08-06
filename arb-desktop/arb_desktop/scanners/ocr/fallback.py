from __future__ import annotations

from arb_desktop.models import DetectionTier, Matchup, SiteId
from arb_desktop.scanners.tiers import OcrScanner


class ScreenOcrScanner(OcrScanner):
    """3순위: OpenCV + Tesseract 화면 OCR (선택적 의존성)."""

    def __init__(self, site: SiteId, region: tuple[int, int, int, int] | None = None):
        self.site = site
        self.region = region  # left, top, width, height

    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        try:
            import cv2  # type: ignore
            import mss  # type: ignore
            import numpy as np  # type: ignore
            import pytesseract  # type: ignore
        except ImportError:
            return [], "OCR dependencies not installed (pip install arb-desktop[ocr])"

        with mss.mss() as sct:
            monitor = sct.monitors[1]
            if self.region:
                left, top, width, height = self.region
                shot = sct.grab({"left": left, "top": top, "width": width, "height": height})
            else:
                shot = sct.grab(monitor)

        img = np.array(shot)
        gray = cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
        text = pytesseract.image_to_string(gray, lang="eng+kor")
        matchups = self._parse_text(text)
        return matchups, f"OCR {len(matchups)} matchups (fallback)"

    def _parse_text(self, text: str) -> list[Matchup]:
        import re

        out: list[Matchup] = []
        for line in text.splitlines():
            m = re.search(
                r"([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,40}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-]{1,40}).*?(\d+\.\d{2,3})",
                line,
                re.I,
            )
            if not m:
                continue
            home, away, odds_s = m.group(1).strip(), m.group(2).strip(), m.group(3)
            try:
                odds = float(odds_s)
            except ValueError:
                continue
            if odds <= 1.01:
                continue
            from arb_desktop.models import MoneylineSelection
            from arb_desktop.timing import now_ns

            captured = now_ns()
            out.append(
                Matchup(
                    site=self.site,
                    event_id=f"{home}|{away}".lower(),
                    home=home,
                    away=away,
                    moneyline=[
                        MoneylineSelection(team=home, side="home", decimal=odds, source_tier=DetectionTier.OCR, captured_ns=captured)
                    ],
                    source_tier=DetectionTier.OCR,
                    captured_ns=captured,
                )
            )
        return out
