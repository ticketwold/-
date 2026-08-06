from __future__ import annotations

import argparse
import asyncio

from arb_desktop.betslip.auto_pipeline import AutoBetPipeline
from arb_desktop.betslip.execution_models import ExecutionStage
from arb_desktop.config import settings
from arb_desktop.scanners.playwright.chrome_profile import ChromeProfileError
from arb_desktop.scanners.playwright.cli_browser import add_browser_arguments, apply_browser_arguments
from arb_desktop.scanners.playwright.session import BrowserSession, log_step


async def wait_for_enter(prompt: str) -> None:
    await asyncio.to_thread(input, prompt)


def _print_result(result) -> None:
    print(f"\n[PIPELINE] stage={result.stage.value} ok={result.ok} reason={result.reason}", flush=True)
    if result.arbitrage:
        arb = result.arbitrage
        print(
            f"  profit={arb.profit_rate}% bc_stake={arb.stake_a} bti_stake={arb.stake_b}",
            flush=True,
        )
    if result.bc_stake_input is not None:
        print(f"  bc_input_verified={result.bc_stake_input}", flush=True)
    if result.bti_stake_input is not None:
        print(f"  bti_input_verified={result.bti_stake_input}", flush=True)
    print("\n[LATENCY]", flush=True)
    for line in result.latency.log_lines():
        print(f"  {line}", flush=True)


def _print_browser_info() -> None:
    print("=== Auto BetSlip Pipeline v1.2.0 ===", flush=True)
    print(f"dry_run={settings.dry_run} live_execution={settings.live_execution_enabled}", flush=True)
    print(f"Chrome: {settings.chrome_executable}", flush=True)
    print(f"User Data: {settings.chrome_user_data_dir}", flush=True)
    print(f"Profile: {settings.chrome_profile_directory}", flush=True)
    print("", flush=True)
    print("Chrome을 완전히 종료한 뒤 실행하세요 (프로필 잠금 방지).", flush=True)
    print("양쪽 배팅카트 준비 후 Enter → SCAN~READY (Bet 버튼 자동 클릭 없음)", flush=True)
    print("", flush=True)


async def run(*, input_stakes: bool, debug: bool) -> int:
    session = BrowserSession()
    pipeline = AutoBetPipeline(session)

    _print_browser_info()

    try:
        await session.start()
    except ChromeProfileError as exc:
        print(f"[ERROR] {exc}", flush=True)
        return 1
    except Exception as exc:
        print(f"[ERROR] Chrome 시작 실패: {exc}", flush=True)
        return 1

    result = None
    try:
        log_step("[STEP4] Waiting Enter")
        await wait_for_enter("Press Enter to start pipeline... ")
        log_step("[STEP5] Start Pipeline")
        result = await pipeline.run(enable_input=input_stakes and not settings.dry_run, debug=debug)
        _print_result(result)

        if result.stage == ExecutionStage.READY and settings.live_execution_enabled:
            print("\n[INFO] LIVE 모드 — 사용자 Bet 버튼 클릭 대기 (자동 클릭 안 함)", flush=True)

        await asyncio.sleep(5)
    finally:
        await session.stop()
    return 0 if result and result.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="BetSlip 자동배팅 파이프라인 v1.2.0")
    add_browser_arguments(parser)
    parser.add_argument("--input", action="store_true", help="드라이런 해제 시 stake 자동 입력")
    parser.add_argument("--live", action="store_true", help="Live execution 플래그 (Bet 클릭은 여전히 수동)")
    parser.add_argument("--debug", action="store_true", help="BetSlip 스캔 디버그 로그")
    args = parser.parse_args(argv)

    apply_browser_arguments(args)
    if args.live:
        settings.live_execution_enabled = True

    return asyncio.run(run(input_stakes=args.input, debug=args.debug))


if __name__ == "__main__":
    raise SystemExit(main())
