# 양방 확장 v2.98 (arb_v294 기반)

GitHub `-2` 저장소에서 받은 **전체 확장** + pbc00 BTI 서치 수정본입니다.

## Edge/Chrome 설치

1. `edge://extensions` 또는 `chrome://extensions`
2. **개발자 모드** 켜기
3. **압축해제된 확장 프로그램 로드** → 이 폴더(`extension-legacy`) 선택
4. 기존 v2.97 확장이 있으면 **비활성화** 후 이 버전만 사용

## 사용 순서

1. **pbc00.com** 로그인
2. 10벳(BTI) 스포츠 화면 열기 (배당 버튼이 보이는 상태)
3. **pinnacle.com** 탭도 열기 (프리매치 한국어 팀명용)
4. 확장 팝업 → **프리매치 서치** 또는 **라이브 서치** 실행

## v2.98 수정 (BTI 서치)

- **원인**: pbc00 탭에서 API를 `prod188.bti-sports.io`로 호출하면 로그인 쿠키가 없어 실패
- **수정**: BTI **iframe origin**을 자동 감지해 해당 프레임에서 `fetch` (쿠키 포함)
- **폴백**: API 실패 시 배당판 DOM 스캔 (`master_fe_Selections_selection` 버튼)

## 문제 해결

| 증상 | 확인 |
|------|------|
| BTI 0건 | pbc00 로그인 + BTI 배당 화면 열림 여부 |
| 프리매치 0건 | F12 → 확장 Service Worker 콘솔에서 `[BTI]` 로그 |
| 팀 매칭 안 됨 | 팝업 **팀명 진단** 버튼 |

## 파일

- `background.js` — Pinnacle/BTI/SBO API + 양방 서치
- `bti_content.js` — 슬립/베팅 + DOM 스캔 + `FETCH_BTI_JSON`
- `popup.js` / `popup.html` — UI

원본 zip: https://github.com/ticketwold/-2 (`arb_v297.zip`)
