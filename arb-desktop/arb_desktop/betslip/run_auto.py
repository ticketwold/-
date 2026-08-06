from __future__ import annotations

import argparse
import asyncio
import sys

from arb_desktop.betslip.run_bridge import main as bridge_main


def main(argv: list[str] | None = None) -> int:
    print(
        "run_auto_betslip은 Chrome Bridge 모드로 전환되었습니다.\n"
        "기존 Chrome 탭 + chrome-bridge 확장프로그램을 사용하세요.\n",
        flush=True,
    )
    return bridge_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
