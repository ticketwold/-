from __future__ import annotations

import argparse
import asyncio
import sys
from time import monotonic

from arb_desktop.betslip.format import empty_betslip_block, format_betslip_block
from arb_desktop.betslip.models import BetSlipItem, SlipStatus
from arb_desktop.betslip.readers.dom import read_bc_betslip, read_bti_betslip
from arb_desktop.config import settings
from arb_desktop.scanners.playwright.session import BrowserSession


class BetSlipLogger:
    def __init__(self, stream=None) -> None:
        self._out = stream or sys.stdout

    def line(self, msg: str = "") -> None:
        print(msg, file=self._out, flush=True)

    def log_item(self, item: BetSlipItem) -> None:
        self.line(format_betslip_block(item))

    def log_empty(self, site: str, reason: str = "") -> None:
        self.line(empty_betslip_block(site, SlipStatus.EMPTY, reason))


async def verify_once(session: BrowserSession, logger: BetSlipLogger) -> None:
    bc = await read_bc_betslip(session.bc_page)
    bti = await read_bti_betslip(session.bti_page)

    logger.line("--- BetSlip scan ---")
    if bc.first:
        logger.log_item(bc.first)
    else:
        logger.log_empty(bc.site or "BC.Game", bc.reason or "empty")

    logger.line("")

    if bti.first:
        logger.log_item(bti.first)
    else:
        logger.log_empty(bti.site or "x10x10s", bti.reason or "empty")

    logger.line("")
    logger.line(f"[DEBUG] BC frame: {bc.frame_url or '-'}")
    logger.line(f"[DEBUG] BTI frame: {bti.frame_url or '-'}")


async def run_verify(
    *,
    wait_sec: int = 60,
    poll_sec: float = 2.0,
    keep_open_sec: int = 30,
    once: bool = False,
) -> int:
    logger = BetSlipLogger()
    session = BrowserSession()

    logger.line("=== BetSlip 검증 도구 ===")
    logger.line("BC.Game / x10x10s 각각 배팅카트에 항목 1개를 담아 주세요.")
    logger.line(f"대기: {wait_sec}s | 폴링: {poll_sec}s | 종료 전 유지: {keep_open_sec}s")
    logger.line("")

    await session.start()

    try:
        deadline = monotonic() + wait_sec
        found_bc = False
        found_bti = False

        while monotonic() < deadline:
            remaining = int(deadline - monotonic())
            logger.line(f"[WAIT] 배팅카트 준비 대기... ({remaining}s)")
            await verify_once(session, logger)

            bc = await read_bc_betslip(session.bc_page)
            bti = await read_bti_betslip(session.bti_page)
            found_bc = bool(bc.first and (bc.first.event or bc.first.selection))
            found_bti = bool(bti.first and (bti.first.event or bti.first.selection))

            if once or (found_bc and found_bti):
                break
            await asyncio.sleep(poll_sec)

        if not once:
            logger.line("")
            logger.line("=== 최종 BetSlip ===")
            await verify_once(session, logger)

        if keep_open_sec > 0:
            logger.line(f"[INFO] 브라우저 {keep_open_sec}s 유지...")
            await asyncio.sleep(keep_open_sec)
    finally:
        await session.stop()

    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="BC.Game / x10x10s BetSlip 검증")
    parser.add_argument("--wait", type=int, default=60, help="배팅카트 준비 대기(초)")
    parser.add_argument("--poll", type=float, default=2.0, help="폴링 간격(초)")
    parser.add_argument("--keep-open", type=int, default=30, help="종료 전 브라우저 유지(초)")
    parser.add_argument("--no-keep-open", action="store_true", help="검증 후 즉시 종료")
    parser.add_argument("--once", action="store_true", help="1회 스캔 후 종료")
    args = parser.parse_args(argv)

    keep_open = 0 if args.no_keep_open else args.keep_open
    return asyncio.run(
        run_verify(
            wait_sec=args.wait,
            poll_sec=args.poll,
            keep_open_sec=keep_open,
            once=args.once,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
