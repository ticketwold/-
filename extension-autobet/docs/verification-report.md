# DOM Scanner 검증 보고서

> 실행 시각: 2026-08-03  
> 버전: v3.1.1  
> 환경: Cloud Agent (Chrome Playwright + Vitest/happy-dom)

---

## 요약

| 항목 | 결과 |
|------|------|
| Vitest 단위/통합 테스트 | **22/22 PASS** |
| Playwright 실제 Chrome E2E (fixture DOM) | **5/5 PASS** |
| BC 12회 배당 변경 | **12/12 일치** |
| x10 12회 배당 변경 | **12/12 일치** (보드 11.50 미유출) |
| 정지된/Suspended 차단 | **PASS** |
| 라이브 x10x10s slip 검증 | **불가** (Cloudflare 403) |
| 라이브 BC.Game slip 검증 | **불가** (로그인·선택 필요, extension 미주입) |

---

## 1. x10x10s / BC.Game 배당 읽기

### 자동 검증 (fixture DOM — 실제 Chrome)

**BC.Game** — `bet__winner-coef` 12회 변경:

```json
[{"expected":1.85,"actual":1.85},{"expected":1.9,"actual":1.9},{"expected":1.95,"actual":1.95},{"expected":2,"actual":2},{"expected":2.05,"actual":2.05},{"expected":2.1,"actual":2.1},{"expected":1.88,"actual":1.88},{"expected":1.92,"actual":1.92},{"expected":2.15,"actual":2.15},{"expected":2.2,"actual":2.2},{"expected":1.75,"actual":1.75},{"expected":2.3,"actual":2.3}]
```

**x10x10s** — `@ 1.xx` slip 12회 변경 (보드 11.50 동시 존재):

```json
[{"expected":1.12,"actual":1.12},...,{"expected":1.23,"actual":1.23}]
```

### 라이브 사이트

| 사이트 | HTTP | 비고 |
|--------|------|------|
| x10x10s.com | **403** Cloudflare | 이 환경에서 in-play/slip DOM 접근 불가 |
| bc.game/sports | **200** | 페이지 로드 OK, slip 미선택 시 `bet__winner-coef` 0개 |

**→ 로그인된 사용자 브라우저에서 extension 로드 후 수동 확인 필요**

---

## 2. W1 클릭 ↔ Scanner 배당 일치

fixture에서 x10 slip card `betInformation__title: W1`, `@ 1.16` → Scanner `1.16` 읽기 **PASS** (`selector-engine.test.ts`, `scanner-engine.test.ts`)

---

## 3. MutationObserver / React 재렌더

- `scanner-engine.test.ts`: DOM text 변경 → MO → `1.22` emit **PASS**
- Playwright E2E: 12회 연속 DOM 변경마다 `readOdds()` 즉시 반영 **PASS**

---

## 4. 배팅 추가/삭제 즉시 갱신

- slip card + counter 제거 시 board 11.50 미전달 **PASS** (`scanner-engine.test.ts`)
- BC active coef → suspended `정지된` 전환 시 `readOdds()` → `null` **PASS** (Vitest + Playwright)

---

## 5. Scanner ↔ Legacy 덮어쓰기

- `legacy-coexistence.test.ts`: wrapper가 scanner 우선, 실패 시 legacy fallback **PASS**
- BC: `bc_slip_read.js`가 `__bcReadNativeSlip` 등록 후 `content.ts` wrapper가 병합

---

## 6. 정지된 / Suspended / NaN 차단

`odds-parser.test.ts` — 다음 모두 `null`:

`정지된`, `정지됨`, `Suspended`, `closed`, `""`, `NaN`, `abc`

---

## 7. 슬립 vs 보드 오탐

- x10 fixture: board `11.50` 존재, scanner는 `1.16`만 읽음 **PASS**
- BC fixture: board `12.10` 존재, scanner는 `2.00`만 읽음 **PASS**

---

## 8. 10회+ 배당 변경 테스트

| 대상 | 횟수 | 결과 |
|------|------|------|
| BC fixture (Chrome) | 12 | 12/12 |
| x10 fixture (Chrome) | 12 | 12/12 |
| BC Vitest sequential | 10 | 10/10 |

---

## 재현 명령

```bash
cd extension-autobet
npm run test          # Vitest 22 tests
npm run test:e2e      # Playwright Chrome E2E
```

---

## 알려진 제한 / 남은 리스크

1. **라이브 x10x10s**: Cloudflare 403 — cloud 환경에서 실사이트 slip 검증 불가
2. **라이브 BC.Game**: 로그인·경기 선택·extension 주입 없이는 slip DOM 없음
3. **BC Shadow DOM closed root**: `chrome.dom.openOrClosedShadowRoot` 의존 — 일부 Betby 위젯에서 추가 튜닝 필요할 수 있음
4. **중복 ODDS_CHANGED**: legacy `content.legacy.ts` observer와 scanner가 동시 emit 가능 (panel dedup 의존)
5. **iframe 3단 이상 중첩**: registry가 1단 attach — 깊은 중첩 iframe은 미검증
6. **W1 실클릭 E2E**: fixture 시뮬레이션만 검증, 실제 in-play LoL 클릭은 사용자 환경 필요

---

## 사용자 수동 확인 체크리스트

1. `extension-autobet-v3.1.1.zip` 설치 후 탭 새로고침
2. F12 → `[DOM Scanner / 텐텐뱃] boot` 또는 `[DOM Scanner / BC.Game] boot` 확인
3. W1 클릭 + 베팅금 입력 → `__btiSlipProbe()` / `__bcScannerProbe()` 실행
4. `localStorage.setItem('autobet-odds-debug','1')` 후 배당 raw 로그 확인
