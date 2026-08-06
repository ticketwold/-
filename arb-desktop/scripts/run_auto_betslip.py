#!/usr/bin/env python3
"""BetSlip 자동배팅 파이프라인 v1.0.4.

SCAN → VERIFY → CALCULATE → RECHECK → INPUT → VERIFY INPUT → READY
"""

from arb_desktop.betslip.run_auto import main

if __name__ == "__main__":
    raise SystemExit(main())
