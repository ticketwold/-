from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
from playwright.async_api import Browser, BrowserContext, Page, async_playwright

from arb_desktop.config import settings
from arb_desktop.scanners.network.bti_rest import BTI_HOST_HINTS, BtiRestScanner, detect_bti_origin_from_url
from arb_desktop.scanners.network.sptpub_v4 import SptpubV4Client
from arb_desktop.scanners.playwright.chrome_profile import (
    ChromeProfileError,
    cdp_endpoint_candidates,
    is_chrome_running,
    launch_args_for_mode,
    resolve_chrome_user_data_dir,
    validate_profile_directory,
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
    """공유 Playwright 세션 — 정식 Chrome persistent 프로필 또는 CDP 연결."""

    def __init__(self) -> None:
        self._pw = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._cdp_attached = False
        self.bti_page: Page | None = None
        self.bc_page: Page | None = None
        self.bti_origin: str | None = None
        self.bti_rest = BtiRestScanner()
        self.sptpub_client = SptpubV4Client()
        self.profile_mode: str = settings.chrome_profile_mode
        self.user_data_path: Path = self._resolve_user_data_path()
        self.profile_directory: str = settings.chrome_profile_directory

    def _resolve_user_data_path(self) -> Path:
        if settings.uses_existing_chrome_profile:
            return resolve_chrome_user_data_dir(settings.chrome_user_data_dir)
        return settings.chrome_profile_dir

    async def start(self) -> None:
        log_step("[STEP1] Launch Chrome")

        if settings.uses_existing_chrome_profile:
            validate_profile_directory(self.user_data_path, self.profile_directory)
        else:
            self.user_data_path.mkdir(parents=True, exist_ok=True)

        self._pw = await async_playwright().start()

        if is_chrome_running():
            log_step("[STEP1] Chrome 실행 중 — CDP 연결 시도")
            if await self._try_connect_cdp():
                log_step("[STEP1] 기존 Chrome CDP 연결 성공")
            else:
                raise ChromeProfileError(
                    "실행 중인 Chrome에 연결하지 못했습니다. "
                    "Chrome 바로가기 대상 끝에 --remote-debugging-port=9222 를 추가한 뒤 "
                    "Chrome을 다시 실행해 주세요."
                )
        else:
            await self._launch_persistent()

        log_step("[STEP2] Open BC")
        log_step("[STEP3] Open x10")
        self.bti_page, self.bc_page = await self._open_site_pages()

        await self.bc_page.goto(settings.bc_sports_url, wait_until="domcontentloaded", timeout=30_000)
        await self.bti_page.goto(settings.bti_wrapper_url, wait_until="domcontentloaded", timeout=30_000)
        await self.wait_for_frames(self.bti_page, timeout_ms=15_000)
        await self._sync_bti_session()
        if setup_monitors and self.bc_page and self.bti_page:
            await setup_monitors(self.bc_page, self.bti_page)

    async def _try_connect_cdp(self) -> bool:
        if not self._pw:
            return False

        endpoints = cdp_endpoint_candidates(self.user_data_path, settings.chrome_cdp_urls)
        for endpoint in endpoints:
            try:
                browser = await self._pw.chromium.connect_over_cdp(
                    endpoint,
                    timeout=settings.chrome_cdp_timeout_ms,
                )
                self._browser = browser
                self._cdp_attached = True
                self._context = browser.contexts[0] if browser.contexts else None
                if self._context:
                    return True
                await _safe_close(lambda: browser.close())
                self._browser = None
                self._cdp_attached = False
            except Exception:
                continue
        return False

    async def _launch_persistent(self) -> None:
        if not self._pw:
            raise RuntimeError("playwright not started")

        launch_args = list(launch_args_for_mode(self.profile_mode, self.profile_directory))
        if settings.chrome_remote_debugging_port > 0:
            launch_args.append(f"--remote-debugging-port={settings.chrome_remote_debugging_port}")

        self._context = await self._pw.chromium.launch_persistent_context(
            user_data_dir=str(self.user_data_path),
            channel=settings.chrome_channel,
            headless=settings.headless,
            viewport={"width": 1400, "height": 900},
            args=launch_args,
        )
        self._browser = None
        self._cdp_attached = False

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

    async def save_state(self) -> None:
        if settings.uses_existing_chrome_profile or self._cdp_attached:
            return
        if not self._context or not settings.persist_sessions:
            return
        backup = self.user_data_path / "storage-backup.json"
        await _safe_close(lambda: self._context.storage_state(path=str(backup)))  # type: ignore[union-attr]

    async def stop(self) -> None:
        await self.bti_rest.close()
        await self.sptpub_client.close()
        if self._cdp_attached:
            if self._browser:
                await _safe_close(lambda: self._browser.close())  # type: ignore[union-attr]
        elif self._context:
            await self.save_state()
            await _safe_close(lambda: self._context.close())  # type: ignore[union-attr]
        if self._browser and not self._cdp_attached:
            await _safe_close(lambda: self._browser.close())  # type: ignore[union-attr]
        if self._pw:
            await _safe_close(lambda: self._pw.stop())  # type: ignore[union-attr]
        self._pw = self._browser = self._context = None
        self._cdp_attached = False

    async def wait_for_frames(self, page: Page, timeout_ms: int = 8000) -> None:
        deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
        while asyncio.get_event_loop().time() < deadline:
            if len(page.frames) > 1:
                return
            await asyncio.sleep(0.2)
