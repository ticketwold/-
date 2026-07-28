# 양방 베팅 봇 v5.0.0

**텐텐뱃 (x10x10s.com) + Polymarket** 전용 Chrome 확장 프로그램.

## 설치

1. Chrome → `chrome://extensions`
2. 개발자 모드 ON
3. **압축해제된 확장 프로그램을 로드합니다** → `extension-legacy` 폴더 선택

## 사용법

1. **x10x10s.com** 에서 10벳 스포츠(BTI) 배당 화면 열기
2. **polymarket.com** 에서 해당 경기 선택 + **금액($) 입력**
3. 확장 **슬립 비교** 탭에서 양쪽 배당 확인
4. 수익률 충족 시 **봇 시작**

## Polymarket 배당 계산

- **To win 금액 ÷ 베팅액** = 배당 (예: $10 → $79.67 = **7.967배**)
- Avg Price 13¢ 같은 센트값은 To win으로 오인하지 않음

## 라이브 서치

- **라이브 서치** 탭: BTI API + Polymarket Gamma API로 양방 기회 탐색
- x10x10s 탭 + Polymarket 탭이 열려 있어야 함

## 파일 구조

| 파일 | 역할 |
|------|------|
| `popup.js` | UI, 슬립 비교, 봇 |
| `background.js` | API 서치 |
| `bti_content.js` | 텐텐뱃 DOM |
| `polymarket_content.js` | Polymarket DOM |
| `odds.js` | 배당/수익 계산 |
| `teams.js` | 팀명 매칭 |
