from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
from playwright.async_api import Browser, BrowserContext, Page, async_playwright

from arb_desktop.config import settings
from arb_desktop.scanners.network.bti_rest import BTI_HOST_HINTS, BtiRestScanner, detect_bti_origin_from_url
from arb_desktop.scanners.network.sptpub_v4 import SptpubV4Client

try:
    from arb_desktop.betslip.dom_runtime import setup_monitors
except ImportError:
    setup_monitors = None  # type: ignore[misc, assignment]


class BrowserSession:
    """공유 Playwright 세션 — 정식 Chrome persistent 프로필로 로그인·쿠키 유지."""

    def __init__(self) -> None:
        self._pw = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self.bti_page: Page | None = None
        self.bc_page: Page | None = None
        self.bti_origin: str | None = None
        self.bti_rest = BtiRestScanner()
        self.sptpub_client = SptpubV4Client()
        self.profile_dir: Path = settings.chrome_profile_dir

    async def start(self) -> None:
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._pw = await async_playwright().start()

        # launch_persistent_context: 전용 프로필에 쿠키·세션 자동 보존 (storage.json 불필요)
        self._context = await self._pw.chromium.launch_persistent_context(
            user_data_dir=str(self.profile_dir),
            channel=settings.chrome_channel,
            headless=settings.headless,
            viewport={"width": 1400, "height": 900},
        )
        self._browser = None

        self.bti_page, self.bc_page = await self._ensure_site_pages()

        await self.bti_page.goto(settings.bti_wrapper_url, wait_until="domcontentloaded", timeout=30_000)
        await self.bc_page.goto(settings.bc_sports_url, wait_until="domcontentloaded", timeout=30_000)
        await self.wait_for_frames(self.bti_page, timeout_ms=15_000)
        await self._sync_bti_session()
        if setup_monitors and self.bc_page and self.bti_page:
            await setup_monitors(self.bc_page, self.bti_page)

    async def _ensure_site_pages(self) -> tuple[Page, Page]:
        if not self._context:
            raise RuntimeError("browser context not started")

        pages = list(self._context.pages)
        if len(pages) >= 2:
            return pages[0], pages[1]

        bti_page = pages[0] if pages else await self._context.new_page()
        bc_page = pages[1] if len(pages) > 1 else await self._context.new_page()
        return bti_page, bc_page

    async def _sync_bti_session(self) -> None:
        if not self._context:
            return
        cookies = await self._context.cookies()
        jar = httpx.Cookies()
        origin = None
        for c in cookies:
            domain = c.get("domain", "").lstrip(".")
            for hint in BTI_HOST_HINTS:
                if hint in domain:
                    scheme = "https"
                    origin = f"{scheme}://{domain}"
                    jar.set(c["name"], c["value"], domain=domain, path=c.get("path", "/"))
        if not origin and self.bti_page:
            for frame in self.bti_page.frames:
                o = detect_bti_origin_from_url(frame.url)
                if o:
                    origin = o
                    break
        if origin:
            self.bti_origin = origin
            self.bti_rest.set_session(origin, jar)

    async def save_state(self) -> None:
        """persistent 프로필 백업용 storage export (선택)."""
        if self._context and settings.persist_sessions:
            backup = self.profile_dir / "storage-backup.json"
            await self._context.storage_state(path=str(backup))

    async def stop(self) -> None:
        await self.bti_rest.close()
        await self.sptpub_client.close()
        if self._context:
            await self.save_state()
            await self._context.close()
        if self._browser:
            await self._browser.close()
        if self._pw:
            await self._pw.stop()
        self._pw = self._browser = self._context = None

    async def wait_for_frames(self, page: Page, timeout_ms: int = 8000) -> None:
        deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
        while asyncio.get_event_loop().time() < deadline:
            if len(page.frames) > 1:
                return
            await asyncio.sleep(0.2)
