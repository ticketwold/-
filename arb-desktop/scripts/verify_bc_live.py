#!/usr/bin/env python3
"""BC.Game 라이브 화면 vs sptpub API 검증 CLI.

사용법:
  cd arb-desktop
  pip install -e .
  playwright install chromium
  python scripts/verify_bc_live.py

BC sports 라이브 탭이 열리고 API/화면 배당 비교 로그가 출력됩니다.
"""

from arb_desktop.validation.verify_bc_live import main

if __name__ == "__main__":
    main()
