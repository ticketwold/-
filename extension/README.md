# 브라우저 확장 (BTI 배당)

pbc00.com 안의 **BTI 스포츠북 iframe**에서 배당을 수집합니다.

## BTI 배당이 0건일 때 체크리스트

1. **manifest.json** → `content_scripts`에 `"all_frames": true` 필수
2. pbc00 **로그인** 후 BTI 경기 목록이 화면에 보여야 함
3. 종목 전환은 텍스트 클릭이 아니라 **postMessage sportId** (bti_content.js 참고)
4. F12 → Network에서 `event`/`market` JSON 요청이 있는지 확인
5. `config/pbc00_bti_samples_*.json` (Python) 또는 확장 popup 로그 확인

## popup.js에서 호출하는 메시지

| type | 용도 |
|------|------|
| `READ_SLIP` | 슬립 카드 + 배당판 매칭 배당 읽기 |
| `PLACE_BET` | 베팅 실행 |
| `VALIDATE_LINE` | 기준점 검증 |
| `BTI_SEARCH` / `SEARCH_ODDS` | **배당판 팀명 검색** (슬립 불필요) |
| `SCRAPE_BOARD` | 배당판 전체 스캔 |
| `PING` | iframe 연결 확인 |

```javascript
chrome.tabs.sendMessage(tabId, { type: 'BTI_SEARCH', query: '삼성' }, { frameId }, cb);
```

**중요:** `frameId`를 지정하거나 background의 `broadcastBti`로 모든 iframe에 전송해야 합니다.

1. `edge://extensions` → 개발자 모드
2. "압축해제된 확장 로드" → 이 `extension` 폴더 선택
3. pbc00 탭 열기 → 확장 아이콘 → "전체 배당 수집"

## 기존 확장과 병합

로컬에 `bti_content.js`, `popup.js`(189KB) 등이 있으면:

- `bti_content.js`의 **search / collectOdds** 함수를 이 버전의 API 파싱·postMessage 로직으로 교체
- `manifest.json`에 **`all_frames: true`** 있는지 확인
