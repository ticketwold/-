# 양방 베팅 봇 v5.9.0

**텐텐뱃 (x10x10s.com) + BC.Game** 전용 Chrome 확장 프로그램.

v5.6.2 배당 서치(BTI API) 기반 — **BC.Game 스포츠 전용** (Polymarket 제거).

## 설치

1. Chrome → `chrome://extensions` → 개발자 모드 ON
2. `압축해제된 확장 프로그램을 로드합니다` → `extension-legacy` 폴더 선택

## 사용법

1. **x10x10s.com** 10벳 스포츠 탭 열기
2. **bc.game/sports** 또는 **bc.game/predictions** 에서 경기 선택 + USDT 금액 입력
3. 확장 아이콘 클릭 → 큰 패널 창에서 슬립 비교 / 계산 시작

## 주요 기능

- **라이브 서치**: BTI API + BC.Game 페이지 스캔으로 양방 기회 탐색
- **슬립 비교**: 텐텐뱃 ↔ BC.Game 배당·금액 실시간 비교
- **금액 자동 동기화**: 계산 시작 시 BC USDT 금액 자동 입력

## 파일 구조

| 파일 | 설명 |
|------|------|
| `bti_content.js` | 텐텐뱃/BTI 슬립·배당판 (v5.6.2 유지) |
| `bc_content.js` | BC.Game 예측/스포츠 DOM |
| `bc_slip_read.js` | BC 스포츠 슬립 읽기 (BetBy iframe) |
| `background.js` | BTI API 서치 + BC 탭 브릿지 |
| `popup.js` / `panel.html` | UI 패널 |
