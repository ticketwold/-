from __future__ import annotations

from arb_desktop.models import DetectionTier, ScanSnapshot, SiteId
from arb_desktop.scanners.base import SiteScanner
from arb_desktop.scanners.network.bc_cdp_tap import BcCdpNetworkTap
from arb_desktop.scanners.ocr.fallback import ScreenOcrScanner
from arb_desktop.scanners.pipeline import TieredPipeline
from arb_desktop.scanners.playwright.bc_scraper import BcDomScanner
from arb_desktop.scanners.playwright.session import BrowserSession


class BcGameScanner(SiteScanner):
    site = SiteId.BC_GAME

    def __init__(self, session: BrowserSession):
        self._session = session
        self._cdp = BcCdpNetworkTap()
        self._dom = BcDomScanner(session.bc_page)
        self._ocr = ScreenOcrScanner(SiteId.BC_GAME)
        self._pipeline = TieredPipeline(
            site=SiteId.BC_GAME,
            network=self._cdp,
            playwright=self._dom,
            ocr=self._ocr,
        )
        self._attached = False

    async def start(self) -> None:
        if self._session.bc_page and not self._attached:
            await self._cdp.attach(self._session.bc_page)
            self._attached = True

    async def stop(self) -> None:
        pass

    async def scan(self) -> ScanSnapshot:
        if not self._attached and self._session.bc_page:
            await self._cdp.attach(self._session.bc_page)
            self._attached = True
        return await self._pipeline.scan()

    @property
    def last_tier(self) -> DetectionTier:
        return self._pipeline.last_tier
