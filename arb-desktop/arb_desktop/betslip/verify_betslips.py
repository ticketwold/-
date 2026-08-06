from __future__ import annotations

import argparse
import asyncio
import json
import sys

from arb_desktop.betslip.format import format_scan_report
from arb_desktop.betslip.readers.dom import list_frame_urls, read_bc_betslip, read_bti_betslip
from arb_desktop.betslip.scanner import BetSlipScanner
from arb_desktop.betslip.matcher import check_slip_pair, calculate_arbitrage, apply_network_verification
from arb_desktop.betslip.models import BetSlipScanResult
from arb_desktop.config import settings
from arb_desktop.scanners.playwright.chrome_profile import ChromeProfileError
from arb_desktop.scanners.playwright.cli_browser import add_browser_arguments, apply_browser_arguments
from arb_desktop.scanners.playwright.session import BrowserSession


async def wait_for_enter(prompt: str) -> None:
    await asyncio.to_thread(input, prompt)


def _print_bc_debug(raw: dict) -> None:
    debug = raw.get("debug") or []
    if not debug:
        return
    print("[BC DEBUG] betslipSelection DOM tree", flush=True)
    for block in debug:
        print(f"  selector: {block.get('selector', '-')}", flush=True)
        for node in block.get("nodes") or []:
            print(
                f"    <{node.get('tag')}> class={node.get('class', '')[:80]} "
                f"attrs={json.dumps(node.get('attrs') or {}, ensure_ascii=False)[:160]}",
                flush=True,
            )
            print(f"      innerText: {node.get('innerText', '')[:200]}", flush=True)
            if node.get("inputValue"):
                print(f"      inputValue: {node.get('inputValue')}", flush=True)


def _print_bti_frames(raw: dict, all_frames: list[str]) -> None:
    print("[BTI DEBUG] frame URLs", flush=True)
    for i, url in enumerate(all_frames):
        print(f"  frame[{i}]: {url[:200]}", flush=True)
    for probe in raw.get("frame_probes") or []:
        print(
            f"  probe frame={probe.get('frame_url', '-')} can_scan={probe.get('can_scan')} "
            f"empty={probe.get('empty')} reason={probe.get('reason', '-')}",
            flush=True,
        )
        for p in probe.get("probes") or []:
            print(
                f"    container={p.get('container_selector', '-')} cards={p.get('card_count')} "
                f"preview={p.get('text_preview', '')[:80]}",
                flush=True,
            )


async def scan_once(session: BrowserSession, *, debug: bool, cart_wait_sec: float) -> BetSlipScanResult:
    bc = await read_bc_betslip(session.bc_page, debug=debug)
    bti = await read_bti_betslip(session.bti_page, debug=debug, wait_sec=cart_wait_sec)

    if debug:
        _print_bc_debug(bc.raw)
        _print_bti_frames(bti.raw, list_frame_urls(session.bti_page))

    match = check_slip_pair(bc, bti)
    match = apply_network_verification(
        match,
        bc_dom_odds=bc.first.odds if bc.first else None,
        bti_dom_odds=bti.first.odds if bti.first else None,
        bc_network_odds=None,
        bti_network_odds=None,
        tolerance=settings.betslip_network_tolerance,
    )
    arbitrage = None
    if match.safe_to_calculate and bc.first and bti.first:
        arbitrage = calculate_arbitrage(bc.first, bti.first)

    return BetSlipScanResult(bc=bc, bti=bti, match=match, arbitrage=arbitrage)


async def run_verify(
    *,
    keep_open_sec: int = 30,
    watch: bool = False,
    watch_interval: float = 1.0,
    debug: bool = False,
    cart_wait_sec: float = 30.0,
) -> int:
    session = BrowserSession()

    print("=== BetSlip 검증 도구 (드라이런) ===", flush=True)
    print(f"Automation profile: {settings.chrome_automation_profile_dir}", flush=True)
    print("1. 자동화 전용 Chrome에서 BC.Game / x10x10s 탭이 열립니다.", flush=True)
    print("2. 필요 시 각 사이트에 직접 로그인하세요 (세션은 프로필에 보존).", flush=True)
    print("3. 양쪽 사이트에 각각 항목 1개를 배팅카트에 담으세요.", flush=True)
    print("4. Enter를 누르면 배팅카트만 스캔합니다.", flush=True)
    if debug:
        print("   [--debug] BC DOM 트리 / BTI frame URL 출력", flush=True)
    print(f"   x10x10s 카트 대기: 최대 {cart_wait_sec:.0f}s", flush=True)
    print("", flush=True)

    try:
        await session.start()
    except ChromeProfileError as exc:
        print(f"[ERROR] {exc}", flush=True)
        return 1

    try:
        await wait_for_enter(">>> Enter를 눌러 배팅카트 스캔... ")

        while True:
            scan = await scan_once(session, debug=debug, cart_wait_sec=cart_wait_sec)
            print(format_scan_report(scan), flush=True)
            print("", flush=True)

            if not watch:
                break

            print(f"[WATCH] 변경 감지 대기 ({watch_interval}s)... Ctrl+C 종료", flush=True)
            last_fp = f"{scan.bc.first.item_key if scan.bc.first else ''}|{scan.bti.first.item_key if scan.bti.first else ''}"
            while True:
                await asyncio.sleep(watch_interval)
                scan = await scan_once(session, debug=False, cart_wait_sec=0)
                fp = f"{scan.bc.first.item_key if scan.bc.first else ''}|{scan.bti.first.item_key if scan.bti.first else ''}"
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
    add_browser_arguments(parser)
    parser.add_argument("--keep-open", type=int, default=30, help="종료 전 브라우저 유지(초)")
    parser.add_argument("--no-keep-open", action="store_true", help="검증 후 즉시 종료")
    parser.add_argument("--watch", action="store_true", help="스캔 후 변경 감지 모드")
    parser.add_argument("--watch-interval", type=float, default=1.0, help="변경 감지 폴링 간격(초)")
    parser.add_argument("--debug", action="store_true", help="BC/BTI DOM 디버그 로그 출력")
    parser.add_argument("--cart-wait", type=float, default=30.0, help="x10x10s 카트 대기(초)")
    args = parser.parse_args(argv)

    apply_browser_arguments(args)
    keep_open = 0 if args.no_keep_open else args.keep_open
    return asyncio.run(
        run_verify(
            keep_open_sec=keep_open,
            watch=args.watch,
            watch_interval=args.watch_interval,
            debug=args.debug,
            cart_wait_sec=args.cart_wait,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
