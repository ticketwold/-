#!/usr/bin/env python3
"""Chrome launch diagnostic — browser.launch vs launch_persistent_context.

Usage:
  cd arb-desktop
  pip install -e .
  python scripts/test_launch.py                 # browser.launch only (default)
  python scripts/test_launch.py --persistent    # launch_persistent_context (15s timeout)
  python scripts/test_launch.py --both          # run both sequentially

Windows + Playwright 1.62 + Chrome 150 notes:
  - launch_persistent_context with the real User Data dir can block if Chrome is
    still running or SingletonLock/Cookie/Socket remain.
  - channel="chrome" on Windows has been reported to hang in some environments;
    this project uses executable_path instead.
  - browser.launch() opens a fresh temp profile and usually returns quickly —
    use it to confirm Playwright/Chrome wiring before testing persistent context.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

from arb_desktop.config import settings
from arb_desktop.scanners.playwright.chrome_profile import ChromeProfileError, validate_launch_allowed
from arb_desktop.scanners.playwright.cli_browser import add_browser_arguments, apply_browser_arguments
from arb_desktop.scanners.playwright.profile_verify import launch_args_for_profile

LAUNCH_TIMEOUT_SEC = 15


def _print_header() -> None:
    print("=== test_launch.py ===", flush=True)
    print(f"chrome_executable: {settings.chrome_executable}", flush=True)
    print(f"chrome_user_data_dir: {settings.chrome_user_data_dir}", flush=True)
    print(f"chrome_profile_directory: {settings.chrome_profile_directory}", flush=True)
    print(f"launch_timeout_sec: {LAUNCH_TIMEOUT_SEC}", flush=True)
    print("", flush=True)


async def test_browser_launch() -> bool:
    print("[TEST] browser.launch(executable_path=...)", flush=True)
    print("[DEBUG] before browser.launch", flush=True)
    pw = await async_playwright().start()
    try:
        browser = await asyncio.wait_for(
            pw.chromium.launch(
                executable_path=str(settings.chrome_executable.resolve()),
                headless=False,
                args=[
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            ),
            timeout=LAUNCH_TIMEOUT_SEC,
        )
        print("[DEBUG] after browser.launch", flush=True)
        try:
            page = await browser.new_page()
            await page.goto("https://example.com", wait_until="domcontentloaded", timeout=15_000)
            title = await page.title()
            print(f"[OK] browser.launch — page title: {title!r}", flush=True)
            return True
        finally:
            await browser.close()
    except (asyncio.TimeoutError, TimeoutError):
        print("[ERROR] browser.launch timeout", flush=True)
        return False
    finally:
        await pw.stop()


async def test_persistent_context() -> bool:
    user_data_dir = Path(settings.chrome_user_data_dir).expanduser().resolve()
    launch_args = launch_args_for_profile(settings.chrome_profile_directory)

    print("[TEST] launch_persistent_context(...)", flush=True)
    print(f"  user_data_dir={user_data_dir}", flush=True)
    print(f"  profile={settings.chrome_profile_directory}", flush=True)
    print("[DEBUG] before launch_persistent_context", flush=True)

    pw = await async_playwright().start()
    try:
        context = await asyncio.wait_for(
            pw.chromium.launch_persistent_context(
                user_data_dir=str(user_data_dir),
                executable_path=str(settings.chrome_executable.resolve()),
                headless=False,
                viewport={"width": 1400, "height": 900},
                args=launch_args,
            ),
            timeout=LAUNCH_TIMEOUT_SEC,
        )
        print("[DEBUG] after launch_persistent_context", flush=True)
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto("chrome://version/", wait_until="domcontentloaded", timeout=20_000)
            print("[OK] launch_persistent_context — chrome://version loaded", flush=True)
            return True
        finally:
            await context.close()
    except (asyncio.TimeoutError, TimeoutError):
        print("[ERROR] launch_persistent_context timeout", flush=True)
        return False
    finally:
        await pw.stop()


async def run(mode: str) -> int:
    _print_header()

    ok = True
    if mode in ("launch", "both"):
        ok = await test_browser_launch() and ok
        if mode == "both":
            print("", flush=True)
    if mode in ("persistent", "both"):
        try:
            validate_launch_allowed(
                Path(settings.chrome_user_data_dir).expanduser().resolve(),
                settings.chrome_profile_directory,
            )
        except ChromeProfileError as exc:
            print(f"[ERROR] {exc}", flush=True)
            return 1
        ok = await test_persistent_context() and ok

    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Chrome launch diagnostic (launch vs persistent context)")
    add_browser_arguments(parser)
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        "--persistent",
        action="store_true",
        help="test launch_persistent_context instead of browser.launch",
    )
    mode_group.add_argument(
        "--both",
        action="store_true",
        help="run browser.launch then launch_persistent_context",
    )
    args = parser.parse_args(argv)
    apply_browser_arguments(args)

    if args.both:
        mode = "both"
    elif args.persistent:
        mode = "persistent"
    else:
        mode = "launch"

    return asyncio.run(run(mode))


if __name__ == "__main__":
    raise SystemExit(main())
