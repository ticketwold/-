from __future__ import annotations

from arb_desktop.models import DetectionTier, ScanSnapshot, SiteId
from arb_desktop.scanners.base import SiteScanner
from arb_desktop.scanners.network.bti_rest import BtiRestScanner
from arb_desktop.scanners.ocr.fallback import ScreenOcrScanner
from arb_desktop.scanners.pipeline import TieredPipeline
from arb_desktop.scanners.playwright.bti_scraper import BtiDomScanner
from arb_desktop.scanners.playwright.session import BrowserSession


class BtiX10Scanner(SiteScanner):
    site = SiteId.BTI_X10

    def __init__(self, session: BrowserSession):
        self._session = session
        self._rest = session.bti_rest
        self._dom = BtiDomScanner(session.bti_page)
        self._ocr = ScreenOcrScanner(SiteId.BTI_X10)
        self._pipeline = TieredPipeline(
            site=SiteId.BTI_X10,
            network=self._rest,
            playwright=self._dom,
            ocr=self._ocr,
        )

    async def start(self) -> None:
        await self._session._sync_bti_session()

    async def stop(self) -> None:
        pass

    async def scan(self) -> ScanSnapshot:
        await self._session._sync_bti_session()
        return await self._pipeline.scan()

    @property
    def last_tier(self) -> DetectionTier:
        return self._pipeline.last_tier
