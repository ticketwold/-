#!/usr/bin/env python3
"""BC.Game / x10x10s BetSlip 검증 CLI (드라이런).

사용법:
  cd arb-desktop
  pip install -e .
  playwright install chromium
  python scripts/verify_betslips.py

1. Chromium에서 BC.Game / x10x10s 탭이 열립니다.
2. 양쪽 사이트에 각각 항목 1개를 배팅카트에 담습니다.
3. Enter를 누르면 배팅카트만 스캔합니다.
"""

from arb_desktop.betslip.verify_betslips import main

if __name__ == "__main__":
    raise SystemExit(main())
