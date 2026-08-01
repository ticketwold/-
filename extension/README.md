# 양방배팅 브라우저 확장 (메인)

Python 없이 **Edge/Chrome 확장만**으로 Pinnacle + BTI(pbc00) 양방을 검색합니다.

## 설치

### 로컬 확장 (arb_v294) — 추천

기존 확장이 `C:\Users\user\Downloads\arb_v297\arb_v294` 에 있으면:

```powershell
cd C:\Users\user\Documents\arbitrage-betting
git pull origin cursor/arbitrage-betting-00df
.\scripts\setup-extension-from-local.ps1
# edge://extensions → extension-installed 폴더 로드
```

자세한 설명: [docs/EXTENSION_LOCAL.md](../docs/EXTENSION_LOCAL.md)

### 저장소 extension 폴더만 사용

```powershell
git pull origin cursor/arbitrage-betting-00df
# edge://extensions → extension 폴더 로드
```

## 사용법

1. 확장 아이콘 클릭
2. **① pbc00 열기** → 로그인 → BTI 경기/배당 화면
3. 종목·팀명 입력 (선택)
4. **② 양방 스캔**
   - Pinnacle: Guest API (자동)
   - BTI: iframe 배당판 스캔 (`master_fe_Selections_selection`)

## 파일 구조

| 파일 | 역할 |
|------|------|
| `bti_content.js` | BTI 슬립/배당판/검색 (v2.21) |
| `background.js` | Pinnacle API + 양방 스캔 오케스트레이션 |
| `pinnacle_api.js` | Pinnacle Guest API |
| `arb_calculator.js` | 양방 수익률 계산 |
| `match_matcher.js` | 팀명 매칭 |
| `popup.html/js` | UI |

## BTI 배당 0건일 때

- pbc00 **로그인** 필수
- **경기 상세** 화면 (배당 버튼이 보여야 함)
- `manifest.json` → `"all_frames": true` 확인
- popup → **BTI 검색**으로 `buttonCount` 확인

## 기존 확장 파일 병합

로컬 `popup.js`(189KB)가 있으면 이 popup을 쓰거나, `background.js`의 `scan-arb` 액션만 기존 popup에 연결하세요:

```javascript
chrome.runtime.sendMessage({
  action: 'scan-arb',
  sport: 'baseball',
  query: '삼성',
  minProfit: 0.5,
  totalStake: 100000,
}, console.log);
```
