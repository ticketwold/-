#!/usr/bin/env python3
"""BC.Game / x10x10s BetSlip 검증 CLI.

사용법:
  cd arb-desktop
  pip install -e .
  playwright install chromium
  python scripts/verify_betslip.py

양쪽 사이트 배팅카트에 항목 1개씩 담은 뒤 아래 형식으로 로그가 출력됩니다:

[BETSLIP]
site:
event:
selection:
odds:
status:
stake:
"""

from arb_desktop.betslip.verify_betslip import main

if __name__ == "__main__":
    raise SystemExit(main())
