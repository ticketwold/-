# 로컬 확장 (arb_v294) 사용 가이드

로컬 확장 경로:

```
C:\Users\user\Downloads\arb_v297\arb_v294
```

## 방법 A — 자동 병합 (추천)

```powershell
cd C:\Users\user\Documents\arbitrage-betting
git pull origin cursor/arbitrage-betting-00df
.\scripts\setup-extension-from-local.ps1
```

다른 경로면:

```powershell
.\scripts\setup-extension-from-local.ps1 -SourceDir "D:\내경로\arb_v294"
```

설치 결과: `extension-installed` 폴더  
→ Edge `edge://extensions` → **이 폴더**를 로드

### 스크립트가 하는 일

| 단계 | 내용 |
|------|------|
| 1 | `arb_v294` 전체를 `extension-installed`로 복사 |
| 2 | **bti_content.js** → v2.21 (배당판 검색 추가) |
| 3 | **manifest.json** → `all_frames: true` 확인 |
| 4 | popup.js가 크면 **기존 popup 유지**, 작으면 저장소 UI 사용 |

---

## 방법 B — 수동 (기존 popup.js 유지)

1. `arb_v294` 폴더를 그대로 쓰되
2. 아래 파일만 교체:

```
arb_v294\bti_content.js  ←  저장소 extension\bti_content.js
```

3. `manifest.json`에서 pbc00 content_script 확인:

```json
{
  "matches": ["https://pbc00.com/*"],
  "js": ["bti_content.js"],
  "all_frames": true
}
```

4. Edge에서 확장 **새로고침**

---

## 기존 popup.js와 연동

기존 popup이 `BTI_SEARCH` / `READ_SLIP` 메시지를내면 v2.21 `bti_content.js`가 응답합니다.

### BTI 팀명 검색 (content script)

```javascript
chrome.runtime.sendMessage(
  { type: 'BTI_SEARCH', query: '삼성' },
  (res) => console.log(res)
);
```

### 양방 스캔 (background — 저장소 background.js 사용 시)

```javascript
chrome.runtime.sendMessage({
  action: 'scan-arb',
  sport: 'baseball',
  query: '삼성',
  minProfit: 0.5,
  totalStake: 100000,
}, console.log);
```

기존 `background.js`만 쓰는 경우: 저장소 `extension/background.js`를 참고해 `scan-arb` 핸들러를 추가하세요.

---

## 파일 대응표

| arb_v294 (로컬) | 역할 |
|-----------------|------|
| `bti_content.js` | BTI 슬립/배당/검색 ← **교체 필수** |
| `popup.js` | 메인 UI (189KB) |
| `background.js` | 탭/메시지 조율 |
| `arb_calculator.js` | 양방 계산 |
| `pinnacle_content.js` | Pinnacle 페이지 |
| `sbobet_content.js` | SBOBET |
| `manifest.json` | 확장 설정 |

---

## BTI 0건일 때

1. pbc00 **로그인**
2. **경기 상세** 화면 (배당 버튼 `master_fe_Selections_selection`)
3. F12 콘솔에 `[BTI봇] content script 로드됨 (v2.21)` 확인
4. `buttonCount: 0`이면 → `all_frames: true` 미설정

---

## 프로젝트에 로컬 폴더 넣기 (선택)

로컬 파일을 Git에 올리려면:

```powershell
xcopy /E /I "C:\Users\user\Downloads\arb_v297\arb_v294" "C:\Users\user\Documents\arbitrage-betting\extension-legacy"
```

이후 Cursor/에이전트가 직접 수정할 수 있습니다.
