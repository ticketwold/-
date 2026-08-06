from __future__ import annotations

import argparse
import asyncio

from arb_desktop.betslip.auto_pipeline import AutoBetPipeline
from arb_desktop.betslip.execution_models import ExecutionStage
from arb_desktop.config import settings
from arb_desktop.scanners.playwright.chrome_profile import ChromeProfileError
from arb_desktop.scanners.playwright.cli_browser import add_browser_arguments, apply_browser_arguments
from arb_desktop.scanners.playwright.profile_setup import setup_automation_profile
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
    print("=== Auto BetSlip Pipeline v1.1.1 ===", flush=True)
    print(f"dry_run={settings.dry_run} live_execution={settings.live_execution_enabled}", flush=True)
    print(f"Chrome: {settings.chrome_executable}", flush=True)
    print(f"Automation profile: {settings.chrome_automation_profile_dir}", flush=True)
    print("", flush=True)
    print("자동화 전용 프로필(arb-chrome-profile)만 사용합니다.", flush=True)
    print("양쪽 배팅카트 준비 후 Enter → SCAN~READY (Bet 버튼 자동 클릭 없음)", flush=True)
    print("", flush=True)


def run_setup_profile(*, force: bool) -> int:
    log_step("[STEP0] Prepare dedicated automation profile")
    try:
        result = setup_automation_profile(
            source_user_data=settings.chrome_source_user_data_dir,
            source_profile_name=settings.chrome_source_profile_directory,
            automation_dir=settings.chrome_automation_profile_dir,
            force=force,
        )
    except ChromeProfileError as exc:
        print(f"[ERROR] {exc}", flush=True)
        return 1

    if result.already_configured:
        print("[INFO] 자동화 프로필이 이미 설정되어 있습니다. (--force-setup 으로 재복제)", flush=True)
        return 0

    print(
        f"[OK] 복제 완료: {result.source_profile} → {result.destination}",
        flush=True,
    )
    print(
        f"  files={result.copied_files} dirs={result.copied_dirs} skipped={result.skipped}",
        flush=True,
    )
    print("[INFO] BC.Game 로그인이 풀려 있으면 자동화 Chrome에서 한 번 직접 로그인하세요.", flush=True)
    return 0


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
    parser = argparse.ArgumentParser(description="BetSlip 자동배팅 파이프라인 v1.1.1")
    add_browser_arguments(parser)
    parser.add_argument("--input", action="store_true", help="드라이런 해제 시 stake 자동 입력")
    parser.add_argument("--live", action="store_true", help="Live execution 플래그 (Bet 클릭은 여전히 수동)")
    parser.add_argument("--debug", action="store_true", help="BetSlip 스캔 디버그 로그")
    args = parser.parse_args(argv)

    apply_browser_arguments(args)
    if args.live:
        settings.live_execution_enabled = True

    if args.setup_profile:
        return run_setup_profile(force=args.force_setup)

    return asyncio.run(run(input_stakes=args.input, debug=args.debug))


if __name__ == "__main__":
    raise SystemExit(main())
