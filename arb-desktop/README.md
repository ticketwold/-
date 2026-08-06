# 양방 배팅 데스크톱 (arb-desktop)

Chrome 확장프로그램을 **전용 데스크톱 앱**으로 재설계한 프로젝트입니다.

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                     PyQt6 Dashboard UI                          │
│  배당 표시 · 감지 latency(ms) · 예상 손익 · 스캔 제어           │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                      Coordinator (asyncio)                        │
│  tick loop · FX rate · OddsEngine · 목표 틱 <50ms               │
└───────┬──────────────────────────────────────────────┬──────────┘
        │                                              │
┌───────▼──────────────┐                    ┌──────────▼───────────┐
│  BtiX10Scanner       │                    │  BcGameScanner       │
│  TieredPipeline      │                    │  TieredPipeline      │
└───────┬──────────────┘                    └──────────┬───────────┘
        │                                              │
   1순위 REST API                                 1순위 CDP Network Tap
   sportscenter/inplay                            HTTP + WebSocket JSON
   sportscenter/prematch                          BetBy 원본 payload 파싱
        │                                              │
   2순위 Playwright DOM                           2순위 Playwright DOM
   BTI iframe 배당판                              BetBy iframe 다중 selector
        │                                              │
   3순위 OCR (optional)                           3순위 OCR (optional)
```

## 감지 우선순위

| 순위 | 방식 | BTI (x10x10s) | BC.Game |
|------|------|---------------|---------|
| 1 | Network | REST `sportscenter/*` API | sptpub `/api/v4/live` + `/api/v4/prematch` JSON 재귀 파싱 |
| 2 | Playwright | iframe DOM scrape | BetBy iframe DOM |
| 3 | OCR | 화면 인식 fallback | 화면 인식 fallback |

**DOM selector 단일 의존 금지** — 각 tier마다 다중 selector + JSON 재귀 파서 사용.

## 설치

```bash
cd arb-desktop
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .
playwright install chromium
```

OCR fallback (선택):

```bash
pip install -e ".[ocr]"
# 시스템에 tesseract 설치 필요
```

## 실행

```bash
python main.py
# 또는
arb-desktop
```

1. Chromium이 **x10x10s** + **BC.Game /sports/** 탭을 자동으로 엽니다
2. 양쪽 사이트에 **로그인**
3. UI에서 **스캔 시작**

## 설정 (환경변수 `ARB_` 접두사)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `ARB_SCAN_INTERVAL_MS` | 100 | 스캔 주기 |
| `ARB_MIN_PROFIT_PCT` | 0.5 | 최소 수익률 % |
| `ARB_DEFAULT_BTI_STAKE_KRW` | 10000 | 텐텐뱃 기본 금액 |
| `ARB_HEADLESS` | false | 헤드리스 브라우저 |

## 성능 목표

| 구간 | 목표 |
|------|------|
| Network 감지 | ≤10ms (캐시 hit 시) |
| 감지 → 계산 완료 | ≤50ms |
| Playwright DOM fallback | ≤2.5s |

## 모듈 구조

```
arb_desktop/
├── core/           # OddsEngine, team matcher, FX, JSON parser
├── scanners/
│   ├── network/    # BTI REST, BC CDP tap
│   ├── playwright/ # DOM scrapers, browser session
│   ├── ocr/        # OpenCV + Tesseract fallback
│   └── sites/      # BtiX10Scanner, BcGameScanner
├── engine/         # Coordinator (main loop)
├── execution/      # Auto bet placement
└── ui/             # PyQt6 dashboard
```

## 기존 확장프로그램과의 관계

`extension-legacy/`는 참고용으로 유지됩니다.  
새 개발은 **`arb-desktop/`** 에서 진행합니다.

## 라이브 검증 (API ↔ 화면)

```bash
python scripts/verify_bc_live.py
# 또는: arb-verify-bc-live
```

BC sports **라이브** 탭에서 sptpub `/api/v4/live` 와 화면 배당을 비교합니다.

```
[EVENT MATCH]
경기명: T1 vs Gen.G
API odds: T1=2.150, Gen.G=1.720
SCREEN odds: T1=2.150, Gen.G=1.720
차이: T1=+0.000, Gen.G=+0.000
```

실패 시: event id 불일치 / team name 정규화 실패 / market type 불일치

## 향후

- `native/` C++ 모듈로 대량 페어링 계산 가속
- 추가 사이트: `scanners/sites/` 에 Scanner 클래스 추가
- WebSocket 전용 리스너 (BetBy WS URL 확정 시)
