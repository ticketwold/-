# 확장 프로그램 — 스크립트 없이 설치 (수동)

PowerShell / git / bat **전부 안 써도** 됩니다.

---

## 방법 1 — 가장 쉬움 (폴더 그대로 + 파일 1개만 교체)

### 1) Edge에 기존 확장 로드

1. `edge://extensions`
2. 개발자 모드 ON
3. **압축해제된 확장 로드**
4. 폴더 선택:

```
C:\Users\user\Downloads\arb_v297\arb_v294
```

이미 쓰던 확장이면 **새로고침**만 누르면 됩니다.

### 2) bti_content.js 하나만 교체

1. 브라우저에서 아래 주소 열기 (GitHub 원본):

```
https://raw.githubusercontent.com/ticketwold/-/cursor/arbitrage-betting-00df/extension/bti_content.js
```

2. `Ctrl+S` 로 저장
3. 저장 위치:

```
C:\Users\user\Downloads\arb_v297\arb_v294\bti_content.js
```

(덮어쓰기 Yes)

### 3) manifest.json 한 줄 확인

메모장으로 열기:

```
C:\Users\user\Downloads\arb_v297\arb_v294\manifest.json
```

`bti_content.js` 있는 부분에 **`"all_frames": true`** 가 있어야 합니다:

```json
{
  "matches": ["https://pbc00.com/*"],
  "js": ["bti_content.js"],
  "all_frames": true
}
```

없으면 `"all_frames": true,` 한 줄 추가.

### 4) Edge에서 확장 **새로고침**

끝.

---

## 방법 2 — 메모장만 (다운로드도 싫을 때)

1. `arbitrage-betting` 폴더가 있으면:

```
C:\Users\user\Documents\arbitrage-betting\extension\bti_content.js
```

2. 위 파일을 **복사** (Ctrl+C)

3. 붙여넣기:

```
C:\Users\user\Downloads\arb_v297\arb_v294\bti_content.js
```

4. manifest 확인 → 확장 새로고침

`git pull` 은 **안 해도 됨**. 파일만 복사하면 됩니다.

---

## 방법 3 — 탐색기 드래그 (명령어 0개)

1. 탐색기 창 2개 열기
   - 왼쪽: `Documents\arbitrage-betting\extension`
   - 오른쪽: `Downloads\arb_v297\arb_v294`
2. `bti_content.js` 를 오른쪽으로 **드래그 → 덮어쓰기**
3. Edge 확장 새로고침

---

## 테스트

1. pbc00 로그인
2. BTI **경기 상세** (배당 버튼 보이는 화면)
3. F12 콘솔에 나와야 함:

```
[BTI봇] content script 로드됨 (v2.21)
```

4. 확장 popup에서 팀명 검색

---

## BTI 검색만 popup에 넣고 싶을 때

기존 `popup.js` 에서 content script 호출:

```javascript
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.tabs.sendMessage(tab.id, { type: 'BTI_SEARCH', query: '삼성' }, console.log);
});
```

---

## 정리

| 방법 | 필요한 것 |
|------|-----------|
| **추천** | arb_v294 폴더 + bti_content.js 덮어쓰기 + manifest all_frames |
| 스크립트 | install-extension.bat (선택) |
| Python | 안 써도 됨 |

**핵심은 파일 1개(`bti_content.js`) + manifest `all_frames: true` 뿐입니다.**
