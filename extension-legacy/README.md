# 양방 확장 v3.10 (arb_v294 기반)

GitHub `-2` 저장소에서 받은 **전체 확장** + pbc00 BTI 서치 수정본입니다.

## Edge/Chrome 설치

1. `edge://extensions` 또는 `chrome://extensions`
2. **개발자 모드** 켜기
3. **압축해제된 확장 프로그램 로드** → 이 폴더(`extension-legacy`) 선택
4. 기존 확장이 있으면 **비활성화** 후 이 버전만 사용
5. 업데이트: `git fetch origin cursor/arbitrage-betting-00df && git reset --hard origin/cursor/arbitrage-betting-00df` 후 확장 **새로고침**

## 사용 순서

1. **pbc00.com** 로그인
2. 10벳(BTI) 스포츠 화면 열기 (`gamecode=19`, 배당 버튼이 보이는 상태)
3. **pinnacle.com** 탭도 열기 (프리매치 한국어 팀명용)
4. 확장 팝업 → **프리매치 서치** 또는 **라이브 서치** 실행

## v3.10 수정 (BTI 베팅 미체결)

- **BTI iframe 자동 탐색** — pbc00 래퍼가 아닌 베팅카트(`#counter`)가 있는 프레임에서 실행
- **피나클 베팅 후 BTI 슬립 재확인** — 배당변경/UpdateNotification 대기
- **승인 버튼 폴링** — "베팅하기" 클릭 후 승인/확인 버튼 클릭 + 슬립 비움 확인 (가짜 성공 방지)
- **1.8 형식 배당** 검증 지원 (`1.80`만 되던 정규식 수정)
- content script 실패 시 **inject 폴백** (올바른 frameId)

## v3.00 수정 (슬립 비교 + 서치)

- **BTI 슬립 1.8** 등 소수 1자리 배당 인식
- **pbc00 iframe 자동 프로브** — URL 매칭 실패 시 모든 프레임에서 슬립 탐색
- 슬립 미리보기: content script `READ_SLIP` + 캐시 우선

## 문제 해결

| 증상 | 확인 |
|------|------|
| 피나클만 체결 | 팝업 로그 `BTI 베팅 프레임: frame=X` / `피나클 완료 → BTI 재확인` 확인 |
| BTI 0건 | pbc00 로그인 + BTI 배당 화면 열림 여부 |
| 프리매치 0건 | F12 → 확장 Service Worker 콘솔에서 `[BTI]` 로그 |
| 팀 매칭 안 됨 | 팝업 **팀명 진단** 버튼 |

## 파일

- `background.js` — Pinnacle/BTI/SBO API + 양방 서치
- `bti_content.js` — 슬립/베팅 + DOM 스캔 + `FETCH_BTI_JSON`
- `popup.js` / `popup.html` — UI

원본 zip: https://github.com/ticketwold/-2 (`arb_v297.zip`)
