# 브라우저 확장 (BTI 배당)

pbc00.com 안의 **BTI 스포츠북 iframe**에서 배당을 수집합니다.

## BTI 배당이 0건일 때 체크리스트

1. **manifest.json** → `content_scripts`에 `"all_frames": true` 필수
2. pbc00 **로그인** 후 BTI 경기 목록이 화면에 보여야 함
3. 종목 전환은 텍스트 클릭이 아니라 **postMessage sportId** (bti_content.js 참고)
4. F12 → Network에서 `event`/`market` JSON 요청이 있는지 확인
5. `config/pbc00_bti_samples_*.json` (Python) 또는 확장 popup 로그 확인

## 설치 (Edge/Chrome)

1. `edge://extensions` → 개발자 모드
2. "압축해제된 확장 로드" → 이 `extension` 폴더 선택
3. pbc00 탭 열기 → 확장 아이콘 → "전체 배당 수집"

## 기존 확장과 병합

로컬에 `bti_content.js`, `popup.js`(189KB) 등이 있으면:

- `bti_content.js`의 **search / collectOdds** 함수를 이 버전의 API 파싱·postMessage 로직으로 교체
- `manifest.json`에 **`all_frames: true`** 있는지 확인
