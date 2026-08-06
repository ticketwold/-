from __future__ import annotations

import argparse
import asyncio

from arb_desktop.betslip.format import format_betslip_block
from arb_desktop.betslip.matcher import apply_network_verification, calculate_arbitrage, check_slip_pair
from arb_desktop.betslip.models import BetSlipReadResult
from arb_desktop.bridge.app import create_bridge_runtime, print_bridge_startup_info
from arb_desktop.bridge.message_models import BridgeStatus
from arb_desktop.config import settings


def _print_status(status: BridgeStatus) -> None:
    print(status.format_block(), flush=True)


def _print_slip(site: str, read: BetSlipReadResult) -> None:
    label = "BC.Game" if site == "bc" else "x10x10s"
    print(f"\n[{label} BetSlip]", flush=True)
    if read.empty or not read.first:
        print("  (empty)", flush=True)
        if read.reason:
            print(f"  reason={read.reason}", flush=True)
        return
    item = read.first
    print(f"  event={item.event}", flush=True)
    print(f"  market={item.market}", flush=True)
    print(f"  selection={item.selection}", flush=True)
    print(f"  odds={item.odds}", flush=True)
    print(f"  status={item.status.value}", flush=True)
    print(f"  stake={item.stake}", flush=True)
    print(f"  frame={item.frame_url}", flush=True)
    print(f"  formatted:\n{format_betslip_block(item)}", flush=True)


def _print_match(bc: BetSlipReadResult, bti: BetSlipReadResult) -> None:
    match = check_slip_pair(bc, bti)
    match = apply_network_verification(
        match,
        bc_dom_odds=bc.first.odds if bc.first else None,
        bti_dom_odds=bti.first.odds if bti.first else None,
        bc_network_odds=None,
        bti_network_odds=None,
        tolerance=settings.betslip_network_tolerance,
    )
    print("\n[MATCH]", flush=True)
    print(f"  same_event={match.same_event}", flush=True)
    print(f"  same_market={match.same_market}", flush=True)
    print(f"  opposite_selection={match.opposite_selection}", flush=True)
    print(f"  safe_to_calculate={match.safe_to_calculate}", flush=True)
    if match.reason:
        print(f"  reason={match.reason}", flush=True)
    if match.safe_to_calculate and bc.first and bti.first:
        arb = calculate_arbitrage(
            bc.first,
            bti.first,
            bti_base_stake_krw=settings.default_bti_stake_krw,
            usdt_rate=settings.default_usdt_rate,
        )
        print("\n[CALCULATE]", flush=True)
        print(f"  profit_rate={arb.profit_rate}%", flush=True)
        print(f"  bc_stake={arb.stake_a} bti_stake={arb.stake_b}", flush=True)
        print("\n[READY] dry-run — Bet 버튼 자동 클릭 없음", flush=True)


async def run(*, once: bool = False, interval: float = 2.0) -> int:
    last_status: BridgeStatus | None = None

    def on_status(status: BridgeStatus) -> None:
        nonlocal last_status
        if last_status != status:
            print("", flush=True)
            _print_status(status)
            last_status = status

    def on_slip(site: str, read: BetSlipReadResult) -> None:
        _print_slip(site, read)
        if site == "bc":
            bti = runtime.manager.get_bti_read()
            if not bti.empty:
                _print_match(read, bti)
        else:
            bc = runtime.manager.get_bc_read()
            if not bc.empty:
                _print_match(bc, read)

    runtime = create_bridge_runtime(on_status_change=on_status, on_slip_update=on_slip)
    print_bridge_startup_info(runtime)

    await runtime.start()
    _print_status(runtime.status())

    try:
        if once:
            await runtime.server.request_status()
            await asyncio.sleep(interval)
            _print_slip("bc", runtime.manager.get_bc_read())
            _print_slip("bti", runtime.manager.get_bti_read())
            return 0

        while True:
            await runtime.server.request_status()
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        raise
    finally:
        await runtime.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Chrome Bridge BetSlip 연결 CLI v1.3.0")
    parser.add_argument("--once", action="store_true", help="상태 1회 출력 후 종료")
    parser.add_argument("--interval", type=float, default=2.0, help="상태 폴링 간격(초)")
    args = parser.parse_args(argv)

    try:
        asyncio.run(run(once=args.once, interval=args.interval))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
