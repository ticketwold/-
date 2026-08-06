from __future__ import annotations

import argparse
import asyncio
import sys

from arb_desktop.betslip.auto_pipeline import AutoBetPipeline
from arb_desktop.betslip.execution_models import ExecutionStage
from arb_desktop.config import settings
from arb_desktop.scanners.playwright.session import BrowserSession


async def wait_for_enter(prompt: str) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, lambda: input(prompt))


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


async def run(*, input_stakes: bool) -> int:
    session = BrowserSession()
    pipeline = AutoBetPipeline(session)

    print("=== Auto BetSlip Pipeline v1.0.4 ===", flush=True)
    print(f"dry_run={settings.dry_run} live_execution={settings.live_execution_enabled}", flush=True)
    print("1. 양쪽 배팅카트에 항목을 담으세요.", flush=True)
    print("2. Enter → SCAN~READY 파이프라인 실행", flush=True)
    print("3. 기본 READY에서 종료 (Bet 버튼 자동 클릭 없음)", flush=True)
    print("", flush=True)

    await session.start()
    result = None
    try:
        await wait_for_enter(">>> Enter로 파이프라인 시작... ")
        result = await pipeline.run(enable_input=input_stakes and not settings.dry_run)
        _print_result(result)

        if result.stage == ExecutionStage.READY and settings.live_execution_enabled:
            print("\n[INFO] LIVE 모드 — 사용자 Bet 버튼 클릭 대기 (자동 클릭 안 함)", flush=True)

        await asyncio.sleep(5)
    finally:
        await session.stop()
    return 0 if result and result.ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="BetSlip 자동배팅 파이프라인 v1.0.4")
    parser.add_argument("--input", action="store_true", help="드라이런 해제 시 stake 자동 입력")
    parser.add_argument("--live", action="store_true", help="Live execution 플래그 (Bet 클릭은 여전히 수동)")
    args = parser.parse_args(argv)

    if args.live:
        settings.live_execution_enabled = True
    return asyncio.run(run(input_stakes=args.input))


if __name__ == "__main__":
    raise SystemExit(main())
