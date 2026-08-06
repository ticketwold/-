from __future__ import annotations

import argparse
import asyncio
import sys
from time import monotonic

from arb_desktop.betslip.format import format_scan_report
from arb_desktop.betslip.scanner import BetSlipScanner
from arb_desktop.scanners.playwright.session import BrowserSession


async def wait_for_enter(prompt: str) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: input(prompt))


def _fingerprint(scan) -> str:
    bc = scan.bc.first
    bti = scan.bti.first
    parts = [
        scan.bc.empty,
        scan.bti.empty,
        bc.item_key if bc else "",
        bti.item_key if bti else "",
        bc.odds if bc else "",
        bti.odds if bti else "",
        bc.status.value if bc else "",
        bti.status.value if bti else "",
    ]
    return "|".join(str(p) for p in parts)


async def run_verify(
    *,
    keep_open_sec: int = 30,
    watch: bool = False,
    watch_interval: float = 1.0,
) -> int:
    session = BrowserSession()
    scanner = BetSlipScanner(session)

    print("=== BetSlip 검증 도구 (드라이런) ===", flush=True)
    print("1. Chromium에서 BC.Game / x10x10s 탭이 열립니다.", flush=True)
    print("2. 양쪽 사이트에 각각 항목 1개를 배팅카트에 담으세요.", flush=True)
    print("3. Enter를 누르면 배팅카트만 스캔합니다.", flush=True)
    print("   (실제 배팅 버튼은 절대 누르지 않습니다)", flush=True)
    if watch:
        print("4. --watch 모드: 변경 감지 시 자동 재출력", flush=True)
    print("", flush=True)

    await session.start()

    try:
        await wait_for_enter(">>> Enter를 눌러 배팅카트 스캔... ")

        last_fp = ""
        while True:
            scan = await scanner.scan()
            print(format_scan_report(scan), flush=True)
            print("", flush=True)

            if not watch:
                break

            last_fp = _fingerprint(scan)
            print(f"[WATCH] 변경 감지 대기 ({watch_interval}s)... Ctrl+C 종료", flush=True)
            while True:
                await asyncio.sleep(watch_interval)
                scan = await scanner.scan()
                fp = _fingerprint(scan)
                if fp != last_fp:
                    print("--- 변경 감지 ---", flush=True)
                    print(format_scan_report(scan), flush=True)
                    print("", flush=True)
                    last_fp = fp

        if keep_open_sec > 0:
            print(f"[INFO] 브라우저 {keep_open_sec}s 유지...", flush=True)
            await asyncio.sleep(keep_open_sec)
    except KeyboardInterrupt:
        print("\n[INFO] 중단됨", flush=True)
    finally:
        await session.stop()

    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="BC.Game / x10x10s BetSlip 검증 (드라이런)")
    parser.add_argument("--keep-open", type=int, default=30, help="종료 전 브라우저 유지(초)")
    parser.add_argument("--no-keep-open", action="store_true", help="검증 후 즉시 종료")
    parser.add_argument("--watch", action="store_true", help="스캔 후 변경 감지 모드")
    parser.add_argument("--watch-interval", type=float, default=1.0, help="변경 감지 폴링 간격(초)")
    args = parser.parse_args(argv)

    keep_open = 0 if args.no_keep_open else args.keep_open
    return asyncio.run(
        run_verify(
            keep_open_sec=keep_open,
            watch=args.watch,
            watch_interval=args.watch_interval,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
