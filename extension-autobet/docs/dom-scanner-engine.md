# DOM Scanner Engine — 설계 문서

> 버전: 1.0 · 대상: extension-autobet v3.1+  
> 목적: React 기반 사이트(x10x10s, BC.Game)에서 `querySelector` + 고정 CSS class + `setInterval` 방식의 실패를 근본적으로 해결

---

## 1. 문제 정의

| 기존 방식 | 실패 원인 |
|-----------|-----------|
| `document.querySelector('[class*="betslip_fe_…"]')` | React CSS Modules 해시 변경 |
| top `document` 단일 탐색 | Bet Slip이 child iframe 내부에 lazy mount |
| Shadow DOM 미탐색 | BC.Game Betby 위젯 |
| `setInterval` 폴링 | 배당 변경 타이밍 누락 + CPU 낭비 |
| 고정 observer root | React re-render 시 root 교체 → observer 단절 |

---

## 2. 목표 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                     ScannerEngine                           │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │SiteDetector │──▶│ Site Adapter │──▶│ SelectorEngine  │  │
│  └─────────────┘   │ X10 / BCGame │   └─────────────────┘  │
│                    └──────────────┘                          │
│  ┌─────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │IframeRegistry│  │ PortalWatcher│   │  MutationHub   │  │
│  └─────────────┘   └──────────────┘   └─────────────────┘  │
│         │                  │                    │           │
│         └──────────────────┴────────────────────┘           │
│                            ▼                                │
│                    DomTreeWalker                            │
│              (iframe + shadow 재귀 탐색)                     │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
              onOddsChange(slip) → ODDS_CHANGED
                            │
                            ▼
                    Panel Overlay 갱신
```

### 파이프라인 (요청하신 흐름)

```
Scanner 시작
  → 사이트 감지 (hostname / iframe src)
  → Site Adapter 선택 (X10Scanner | BCGameScanner)
  → DOM Tree 분석 (iframe → shadow → portal)
  → findBetSlip()
  → findOdds() / findStake() / findPayout()
  → MutationHub 연결 (root 자동 재부착)
  → 배당 변경 이벤트 emit
  → Overlay / Panel 갱신
```

---

## 3. 모듈 구조

```
src/scanner/
├── types.ts                 # 공통 타입·인터페이스
├── dom-tree.ts              # iframe + shadow 재귀 DOM 순회
├── selector-engine.ts       # 시맨틱 탐색 (class 해시 금지)
├── iframe-registry.ts       # iframe 생성/제거/load 감시
├── portal-watcher.ts        # body 하위 portal node 감시
├── mutation-hub.ts          # MO + root detach 시 자동 재연결
├── site-detector.ts         # hostname → adapter id
├── scanner-engine.ts        # 오케스트레이터
├── bootstrap.ts             # content script 진입점
├── adapters/
│   ├── base-adapter.ts      # BaseScanner 추상 클래스
│   ├── x10-adapter.ts       # 텐텐뱃 / x10x10s / BTI
│   └── bcgame-adapter.ts    # BC.Game / Betby CDN
└── index.ts
```

---

## 4. 핵심 인터페이스

### 4.1 ScanContext

각 탐색 단위(문서)에 대한 컨텍스트:

```typescript
interface ScanContext {
  doc: Document;
  href: string;
  depth: number;           // iframe 중첩 깊이
  siteId: SiteId;          // 'x10' | 'bcgame' | 'unknown'
  frameLabel: string;      // 'top' | 'sportscenter-betslip' | ...
  via: 'top' | 'iframe' | 'shadow';
}
```

### 4.2 SiteAdapter (BaseScanner)

```typescript
interface SiteAdapter {
  readonly siteId: SiteId;

  /** 이 document에서 Bet Slip UI가 존재할 수 있는지 */
  canScan(ctx: ScanContext): boolean;

  findBetSlip(ctx: ScanContext): BetSlipNode | null;
  findOdds(ctx: ScanContext, slip: BetSlipNode): OddsResult | null;
  findStake(ctx: ScanContext, slip: BetSlipNode): number | null;
  findPayout(ctx: ScanContext, slip: BetSlipNode): number | null;

  /** MO를 붙일 anchor (없으면 body) */
  observerAnchor(ctx: ScanContext, slip: BetSlipNode | null): ParentNode;
}
```

### 4.3 결과 타입

```typescript
interface BetSlipNode {
  root: Element;
  cards: Element[];
  stakeInput: HTMLInputElement | null;
  confidence: number;   // 0–1
}

interface OddsResult {
  odds: number;
  selectionText: string;
  eventText?: string;
  source: string;       // 'x10-slip-card' | 'bc-shadow-slip' | ...
  fromSlip: boolean;
}

interface ScanProbeResult {
  ctx: ScanContext;
  slip: BetSlipNode | null;
  odds: OddsResult | null;
  stake: number | null;
  payout: number | null;
  shadowHostCount: number;
  iframeCount: number;
}
```

---

## 5. Scanner 우선순위 (구현 규칙)

### 5.1 iframe 탐색 (`iframe-registry.ts`)

1. `document.body` MO → `childList` 추가/제거 감지
2. 모든 `iframe` 순회 (중첩 포함)
3. `src` attr 변경 MO (`about:blank` → 실 URL)
4. `load` 이벤트 → `contentDocument` 획득
5. iframe 제거 시 binding teardown + registry에서 삭제
6. 각 iframe document에 독립 `ScanContext` 생성 후 하위 파이프라인 실행

**betslip iframe 힌트** (class 아님): `src` URL 패턴  
`/sportscenter/betslip`, `widgets-x`, `bti-sports`

### 5.2 Shadow DOM 탐색 (`dom-tree.ts`)

- 모든 Element의 `shadowRoot` 재귀 순회 (깊이 제한 64)
- `chrome.dom.openOrClosedShadowRoot` 폴백 (BC.Game closed shadow)
- `walkElements(root, visitor)` — querySelector 대신 순회 기반

### 5.3 React Portal 대응 (`portal-watcher.ts`)

- `document.body` `childList` MO
- body 직계·깊은 자식 추가 시 microtask debounce 후 재스캔
- Portal로 body 끝에 mount되는 slip panel 감지

### 5.4 MutationObserver (`mutation-hub.ts`)

- `subtree: true`, `childList`, `characterData`, `attributes`
- `attributeFilter`: `aria-*`, `data-*`, `value`, `role` (class 해시 미사용)
- **자동 재연결**: observed root가 DOM에서 detach되면 bootstrap MO가 새 anchor 탐색
- `setInterval` **사용 금지** — microtask debounce만 허용

### 5.5 Selector Engine (`selector-engine.ts`)

**금지**: `[class*="betslip_fe_"]`, `[class*="master_fe_"]` 등 해시 class

**허용**:

| 신호 | 예시 |
|------|------|
| id | `#counter` |
| data-* | `[data-testid*="bet-slip"]`, `[data-testid*="betslip"]` |
| aria | `[aria-label*="bet slip"]`, `[role="spinbutton"]` |
| role | `button`, `textbox`, `spinbutton` |
| placeholder | `input[placeholder*="베팅"]` |
| 텍스트 패턴 | `@ 1.16`, `Total odds`, `총 배당` |
| DOM 구조 | stake input + 인접 bet button, card 내 decimal odds |

---

## 6. Site Adapter 상세

### 6.1 X10Scanner (`x10-adapter.ts`)

**감지**: `x10x10s.com`, `bti-sports.*`, sportscenter/widgets-x iframe src

| 메서드 | 전략 |
|--------|------|
| `findBetSlip` | `#counter` 또는 placeholder "베팅" input → 상위 container; 또는 `@ X.XX` 텍스트를 가진 card cluster |
| `findOdds` | card 내 decimal `1.01–99.99`; fallback: root text `@ X.XX` |
| `findStake` | counter/spinbutton input `.value` |
| `findPayout` | "당첨", "payout", "total return" 라벨 인접 숫자 |

**frame 분류** (기존 `SlipFrameKind` 이전):

- `sportscenter-betslip` → scan 허용
- `widgets-x` → scan 허용
- `shell-top` / `junk` → iframe registry만, slip read skip

### 6.2 BCGameScanner (`bcgame-adapter.ts`)

**감지**: `bc.game`, `betby.com`, `sptpub.com` CDN

| 메서드 | 전략 |
|--------|------|
| `findBetSlip` | shadow walk → `[data-testid*="bet"]` / aria "bet slip" / 우측 패널 구조 |
| `findOdds` | `Total odds`, `@`, `coefficient` 라벨 + decimal; payout/stake 비율 역산 |
| `findStake` | stake label 인접 input |
| `findPayout` | "potential win", "payout" 텍스트 인접 |

---

## 7. ScannerEngine 오케스트레이션

```typescript
class ScannerEngine {
  constructor(opts: { onOddsChange: OddsCallback; siteId?: SiteId });

  start(): void;   // iframe registry + portal watcher + top doc MO
  stop(): void;
  probe(): ScanProbeResult;      // 진단 (__btiSlipProbe / __bcDiagReport)
  readOdds(): OddsPayload | null; // 즉시 읽기 (__btiReadSlipOdds / __bcReadSlip)
}
```

### 이벤트 디듀프

```typescript
key = `${odds.toFixed(3)}_${selectionText}`
```

동일 key + `cartChange=false` → emit 생략

### 다중 document 병합

- top + N iframes 동시 스캔
- `confidence` 가장 높은 slip 선택
- engine `readBtiOddsOnce`와 호환: `fromSlip: true`, `source` 문자열 유지

---

## 8. Content Script 통합 (경계면)

기존 `slip-probe.ts` / `slip-observer.ts` / `iframe-lifecycle.ts`는 **deprecated** —  
`scanner/bootstrap.ts`가 단일 진입점.

### BTI (`content/bti/content.ts`)

```typescript
import { startScanner } from '@scanner/bootstrap';

const scanner = startScanner({
  source: 'bti',
  onOddsChange: (slip, cartChange) => chrome.runtime.sendMessage({ type: 'ODDS_CHANGED', ... }),
});

window.__btiSlipProbe = () => scanner.probe();
window.__btiReadSlipOdds = () => scanner.readOdds();
```

### BC (`content/bc/content.ts`)

```typescript
const scanner = startScanner({ source: 'bcgame', ... });
window.__bcReadNativeSlip = () => scanner.readOdds();
```

### Legacy 호환

- `content.legacy.ts`의 `readLiveSlipCartOdds()` → `window.__btiReadSlipOdds()` 우선 호출 (기존 유지)
- `PLACE_BET`, `ENSURE_BTI_SLIP` 등 배팅 로직은 legacy 그대로

---

## 9. Panel / Engine 연동

변경 없음 — 기존 계약 유지:

| 필드 | 요구 |
|------|------|
| `ODDS_CHANGED.source` | `'bti'` \| `'bcgame'` |
| `slip.odds` | `> 1.01` |
| `slip.fromSlip` | `true` (scan 신뢰) |
| `slip.source` / `sourceKind` | adapter별 문자열 |
| `cartChange` | 카트 추가/삭제 시 `true` |

---

## 10. 마이그레이션 단계

| 단계 | 작업 | 상태 |
|------|------|------|
| 1 | 설계 문서 (본 문서) | ✅ |
| 2 | `src/scanner/*` 코어 구현 | ✅ |
| 3 | X10 + BCGame adapter | ✅ |
| 4 | BTI/BC bootstrap 교체 | ✅ |
| 5 | legacy observer 중복 제거 | 후속 |
| 6 | Stake adapter | 후속 |

---

## 11. 테스트 체크리스트

- [ ] x10x10s in-play: W1 클릭 → sportscenter iframe mount → `@ 1.xx` 읽기
- [ ] x10x10s: iframe 재생성 후 observer 자동 재연결
- [ ] BC.Game: shadow DOM slip 배당 읽기
- [ ] Panel `[연결확인]`: `readArbBotBridgeState` + snapshot 정상
- [ ] `setInterval` 미사용 (scanner 모듈 전체 grep)

---

## 12. 설계 원칙 요약

1. **패치 금지** — 새 `src/scanner/` 엔진; legacy는 경계면 hook만
2. **class 해시 금지** — 시맨틱·구조·텍스트 기반 탐색
3. **폴링 금지** — MutationObserver + microtask만
4. **iframe-first** — top document는 shell일 수 있음
5. **adapter 분리** — 사이트별 `findBetSlip/Odds/Stake/Payout` 독립 구현
6. **자동 재연결** — React re-render에 MO root 교체 대응
