from __future__ import annotations

from time import perf_counter
from typing import Union

from arb_desktop.models import DetectionTier, ScanSnapshot, SiteId
from arb_desktop.scanners.tiers import NetworkScanner, OcrScanner, PlaywrightScanner
from arb_desktop.timing import now_ns

ScannerLike = Union[NetworkScanner, PlaywrightScanner, OcrScanner]


class TieredPipeline:
    """WebSocket/HTTP → Playwright DOM → OCR 순서로 시도."""

    def __init__(
        self,
        site: SiteId,
        network: NetworkScanner | None = None,
        playwright: PlaywrightScanner | None = None,
        ocr: OcrScanner | None = None,
    ):
        self.site = site
        self.network = network
        self.playwright = playwright
        self.ocr = ocr
        self._last_tier = DetectionTier.NONE

    @property
    def last_tier(self) -> DetectionTier:
        return self._last_tier

    async def scan(self) -> ScanSnapshot:
        start = perf_counter()
        tiers: list[tuple[DetectionTier, ScannerLike]] = []
        if self.network:
            tiers.append((self.network.tier, self.network))
        if self.playwright:
            tiers.append((self.playwright.tier, self.playwright))
        if self.ocr:
            tiers.append((self.ocr.tier, self.ocr))

        last_msg = "no scanner configured"
        for tier, scanner in tiers:
            try:
                matchups, msg = await scanner.fetch_matchups()
                if matchups:
                    self._last_tier = tier
                    latency = (perf_counter() - start) * 1000
                    return ScanSnapshot(
                        site=self.site,
                        matchups=matchups,
                        tier=tier,
                        latency_ms=latency,
                        ok=True,
                        message=msg,
                        captured_ns=now_ns(),
                    )
                last_msg = msg or f"{tier.value}: empty"
            except Exception as exc:
                last_msg = f"{tier.value}: {exc}"

        self._last_tier = DetectionTier.NONE
        return ScanSnapshot(
            site=self.site,
            matchups=[],
            tier=DetectionTier.NONE,
            latency_ms=(perf_counter() - start) * 1000,
            ok=False,
            message=last_msg,
            captured_ns=now_ns(),
        )
