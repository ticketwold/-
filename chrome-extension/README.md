# arb Extension v2.0.0

Chrome 확장프로그램 단독 구조 — **ArbDesktop.exe / Python / WebSocket Bridge 불필요**.

## 설치

1. `arb-extension-v2.0.0.zip` 압축 해제
2. Chrome → `chrome://extensions`
3. **개발자 모드** ON
4. **압축해제된 확장 프로그램을 로드** → 해제한 폴더 선택

## 사용

1. BC.Game, X10(텐텐벳) 탭을 각각 열기
2. 확장 아이콘 클릭 → **Side Panel** 열림
3. 텐텐벳 배팅금액(KRW), 목표 수익률 설정
4. **BC 금액 자동동기화** ON → 카트 금액 자동 입력 (자동감시와 무관)
5. **자동감시 시작** → TARGET WAIT → STABILIZING → READY → 자동배팅(실제배팅 ON 시)
6. **양쪽 즉시배팅** → 수동 병렬 배팅

## 구조

| 파일 | 역할 |
|------|------|
| `service_worker.js` | FX, watch, stake sync, dispatch |
| `profit_engine.js` | 수익률 / BC stake 계산 |
| `odds_engine.js` | 멀티프레임 slip 집계 (revision) |
| `fx_bithumb.js` | 빗썸 KRW-USDT |
| `bc_stake.js` | BC input write / bet button (기존 stake_actions) |
| `frame_scanner.js` | BetSlip DOM 파싱 |
| `frame_agent.js` | MutationObserver + slip scan |
| `bet_executor.js` | EXECUTE_BET 클릭 |
| `sidepanel.html/js` | UI |

## 로그

Side Panel → 실시간 / 배당로그 / 실행로그 / Debug 탭  
`chrome.storage.local`에 최근 로그 저장, CSV export 지원.

## 데스크톱 앱

v2.0.0부터 **arb-desktop(ArbDesktop.exe)은 사용하지 않습니다.**
