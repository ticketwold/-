# Arb Scanner

Chrome Manifest V3 확장 — **x10x10s** · **BC.Game** 실시간 배당 수집 · 양방 탐지

## 아키텍처

```
content.js (all_frames)
  └─ ScannerEngine
       ├─ dom-walker      iframe + Shadow DOM 재귀
       ├─ mutation-watch  MutationObserver (debounce)
       ├─ spa-watch       pushState / hashchange
       ├─ adapters/
       │    ├─ x10-adapter
       │    └─ bcgame-adapter
       └─ engine          scan → OddsQuote[]

service_worker.js
  ├─ quotes 수집 (chrome.storage)
  ├─ matcher + arb-calculator
  └─ notifications + history

popup / options
```

## 공통 데이터 (`OddsQuote`)

| 필드 | 설명 |
|------|------|
| eventName | 경기명 |
| league | 리그 |
| startTime | 시작시간 |
| selection | W1 / X / W2 등 |
| odds | 배당 |
| source | `slip` \| `board` |
| confidence | 신뢰도 0–1 |

## 설치

```bash
cd arb-scanner
npm install
npm run build
```

Chrome → `chrome://extensions` → 개발자 모드 → **dist** 폴더 로드

## 디버그

활성 탭 F12 콘솔:

```javascript
__arbScannerDiag()   // frame / selector / MO 상태
__arbScannerQuotes() // 마지막 추출 배당
```

설정 → **진단 모드** ON 시 스캔마다 콘솔 출력

## 테스트

```bash
npm test          # Vitest 단위
npm run test:e2e  # Playwright E2E
```

## Selector 정책

- `style__*`, `css-*` 해시 클래스 **사용 안 함**
- `[class*="betInformation"]`, `.bet__winner-coef`, `#counter`, `data-testid` 우선

## 사이트 Adapter 수정

`src/scanner/adapters/x10-adapter.ts` 또는 `bcgame-adapter.ts` 만 수정하면 됩니다.

## 라이선스

Private
