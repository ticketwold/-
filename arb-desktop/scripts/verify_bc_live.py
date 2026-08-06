#!/usr/bin/env python3
"""BC.Game 라이브 화면 vs sptpub API 검증 CLI.

사용법:
  cd arb-desktop
  pip install -e .
  playwright install chromium
  python scripts/verify_bc_live.py

옵션:
  --wait 60          사용자가 스포츠/라이브 탭 클릭할 시간(초)
  --screen-wait 30   화면 경기 로드 대기(초)
  --keep-open 60     결과 확인 후 브라우저 유지(초)
  --no-keep-open     검증 후 즉시 종료

Chromium이 열리면 60초 동안 직접 BC.Game 스포츠/라이브 탭을 클릭하세요.
"""

from arb_desktop.validation.verify_bc_live import main

if __name__ == "__main__":
    main()
