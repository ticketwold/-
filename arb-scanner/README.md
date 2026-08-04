# Arb Scanner v2.0

Chrome Manifest V3 확장 — **x10x10s** · **BC.Game** 실시간 배당 · 양방 · 자동베팅

## 주요 기능

| 기능 | 설명 |
|------|------|
| 배팅카트 배당 실시간 | 슬립 DOM 500ms 폴링 + 스캐너 연동 |
| 수익률 계산 | 설정에서 최소 수익률(%) 지정, 팝업 실시간 표시 |
| 금액 동기화 | x10 KRW 베팅금 → BC USDT 자동 계산·입력 |
| 빗썸 USDT/KRW | 1분마다 자동 갱신 (실패 시 수동 환율) |
| 자동 베팅 | ARM ON + 수익률 충족 시 양쪽 동시 베팅 |
| 알림 | Chrome 알림 + 텔레그램 + 디스코드 웹훅 |

## 아키텍처

```
content.js (all_frames)
  ├─ ScannerEngine        보드 배당 스캔
  ├─ actions.ts           슬립 읽기 / 금액 입력 / 베팅 클릭
  └─ message-handler.ts   background 명령 처리

service_worker.js
  ├─ SLIP_UPDATE → 수익률 · leg2 USDT 계산
  ├─ auto-bet.ts          자동 베팅 엔진
  ├─ tab-bridge.ts        탭/iframe 메시지 브릿지
  ├─ bithumb.ts           USDT/KRW 시세
  └─ notifier.ts          텔레그램 · 디스코드

popup / options
```

## 설치

```bash
cd arb-scanner
npm install
npm run build
```

Chrome → `chrome://extensions` → 개발자 모드 → **dist** 폴더 로드

## 사용법

1. x10x10s, BC.Game 탭을 각각 열고 배팅카트에 선택
2. 확장 팝업에서 x10 베팅금(원) 입력 → **금액 동기화** (또는 자동)
3. 수익률이 목표 이상이면 알림 수신
4. **자동배팅 ON** 후 조건 충족 시 자동 실행 (옵션에서 활성화 필요)
5. **설정**에서 텔레그램 봇/채팅 ID, 디스코드 웹훅, 최소 수익률 설정

## 디버그

활성 탭 F12 콘솔:

```javascript
__arbScannerDiag()
__arbScannerQuotes()
```

## 테스트

```bash
npm test
npm run test:e2e
```

## 라이선스

Private
