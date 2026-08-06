from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
from playwright.async_api import Browser, BrowserContext, Page, async_playwright

from arb_desktop.config import settings
from arb_desktop.scanners.network.bti_rest import BTI_HOST_HINTS, BtiRestScanner, detect_bti_origin_from_url
from arb_desktop.scanners.network.sptpub_v4 import SptpubV4Client
from arb_desktop.scanners.playwright.profile_setup import PROFILE_SUBDIR, ensure_automation_profile_ready
from arb_desktop.scanners.playwright.profile_verify import (
    detect_actual_profile_path,
    expected_profile_path,
    forbid_source_user_data_for_launch,
    launch_args_for_automation,
    resolve_automation_user_data_dir,
    verify_profile_path,
)

try:
    from arb_desktop.betslip.dom_runtime import setup_monitors
except ImportError:
    setup_monitors = None  # type: ignore[misc, assignment]


def _is_target_closed_error(exc: BaseException) -> bool:
    if exc.__class__.__name__ == "TargetClosedError":
        return True
    message = str(exc).lower()
    return "has been closed" in message or "target closed" in message


async def _safe_close(coro_factory) -> None:
    try:
        await coro_factory()
    except Exception as exc:
        if not _is_target_closed_error(exc):
            raise


def log_step(message: str) -> None:
    print(message, flush=True)


class BrowserSession:
    """자동화 전용 Chrome 프로필(arb-chrome-profile)만 사용."""

    def __init__(self) -> None:
        self._pw = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self.bti_page: Page | None = None
        self.bc_page: Page | None = None
        self.bti_origin: str | None = None
        self.bti_rest = BtiRestScanner()
        self.sptpub_client = SptpubV4Client()
        self.automation_user_data_dir: Path = resolve_automation_user_data_dir(
            settings.chrome_automation_profile_dir
        )
        self.profile_subdirectory: str = PROFILE_SUBDIR

    async def start(self) -> None:
        log_step("[STEP0] Prepare dedicated automation profile")
        ensure_automation_profile_ready(self.automation_user_data_dir)
        forbid_source_user_data_for_launch(
            self.automation_user_data_dir,
            settings.chrome_source_user_data_dir,
        )
        self.automation_user_data_dir.mkdir(parents=True, exist_ok=True)

        log_step("[STEP1] Launch dedicated Chrome profile")
        self._pw = await async_playwright().start()

        launch_args = launch_args_for_automation(self.automation_user_data_dir, self.profile_subdirectory)
        self._context = await self._pw.chromium.launch_persistent_context(
            user_data_dir=str(self.automation_user_data_dir),
            executable_path=str(settings.chrome_executable.resolve()),
            headless=settings.headless,
            viewport={"width": 1400, "height": 900},
            args=launch_args,
        )
        self._browser = None

        expected = expected_profile_path(self.automation_user_data_dir, self.profile_subdirectory)
        actual = await detect_actual_profile_path(
            self._context,
            user_data_dir=self.automation_user_data_dir,
            profile_subdir=self.profile_subdirectory,
        )
        verify_profile_path(
            expected=expected,
            actual=actual,
            requested_user_data_dir=self.automation_user_data_dir,
            requested_profile=self.profile_subdirectory,
        )

        log_step("[STEP2] Open BC")
        log_step("[STEP3] Open x10")
        self.bti_page, self.bc_page = await self._open_site_pages()

        await self.bc_page.goto(settings.bc_sports_url, wait_until="domcontentloaded", timeout=30_000)
        await self.bti_page.goto(settings.bti_wrapper_url, wait_until="domcontentloaded", timeout=30_000)
        await self.wait_for_frames(self.bti_page, timeout_ms=15_000)
        await self._sync_bti_session()
        if setup_monitors and self.bc_page and self.bti_page:
            await setup_monitors(self.bc_page, self.bti_page)

    async def _open_site_pages(self) -> tuple[Page, Page]:
        if not self._context:
            raise RuntimeError("browser context not started")

        bc_page = await self._find_or_new_page(
            host_hints=("bc.game", "bcgame"),
            url=settings.bc_sports_url,
        )
        bti_page = await self._find_or_new_page(
            host_hints=("x10x10s", "x10"),
            url=settings.bti_wrapper_url,
            exclude={bc_page},
        )
        return bti_page, bc_page

    async def _find_or_new_page(
        self,
        *,
        host_hints: tuple[str, ...],
        url: str,
        exclude: set[Page] | None = None,
    ) -> Page:
        if not self._context:
            raise RuntimeError("browser context not started")

        excluded = exclude or set()
        for page in self._context.pages:
            if page in excluded:
                continue
            current = page.url.lower()
            if any(hint in current for hint in host_hints):
                return page

        if self._context.pages:
            for page in self._context.pages:
                if page not in excluded:
                    await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                    return page

        return await self._context.new_page()

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

    async def stop(self) -> None:
        await self.bti_rest.close()
        await self.sptpub_client.close()
        if self._context:
            await _safe_close(lambda: self._context.close())  # type: ignore[union-attr]
        if self._browser:
            await _safe_close(lambda: self._browser.close())  # type: ignore[union-attr]
        if self._pw:
            await _safe_close(lambda: self._pw.stop())  # type: ignore[union-attr]
        self._pw = self._browser = self._context = None

    async def wait_for_frames(self, page: Page, timeout_ms: int = 8000) -> None:
        deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
        while asyncio.get_event_loop().time() < deadline:
            if len(page.frames) > 1:
                return
            await asyncio.sleep(0.2)
