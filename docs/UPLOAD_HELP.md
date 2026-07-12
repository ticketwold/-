# 확장 파일 업로드가 안 될 때

Cursor 채팅 첨부 / git push 가 안 되어도 아래 방법 중 **하나**만 하면 됩니다.

---

## 먼저 확인 (30초)

PowerShell:

```powershell
dir C:\Users\user\Downloads\arb_v297\arb_v294
```

파일이 보이면 경로는 맞습니다. `manifest.json`, `bti_content.js` 등이 있어야 합니다.

---

## 방법 1 — 채팅에 직접 붙여넣기 (가장 확실)

zip/git **전부 생략**. 메모장으로 열어서 **내용 복사 → 채팅에 붙여넣기**.

**한 번에 3~4개씩** 보내주세요. 순서:

1. `manifest.json`
2. `bti_content.js`
3. `background.js`
4. `arb_calculator.js`
5. `pinnacle_content.js`
6. `sbobet_content.js`
7. `popup.html`
8. `popup.js` ← 크면 **검색/BTI 관련 부분만** (처음 200줄 + chrome.runtime 부분)

각 메시지 맨 위에 파일명 적기:

```
=== manifest.json ===
(내용)
```

---

## 방법 2 — GitHub 웹사이트에서 올리기

1. 브라우저: https://github.com/ticketwold/-
2. 브랜치: `cursor/arbitrage-betting-00df` 선택
3. `extension-legacy` 폴더 들어가기 (없으면 Add file → Create new file 로 폴더 생성)
4. **Add file → Upload files**
5. `arb_v294` 안의 파일 **드래그**
6. **Commit changes**
7. 채팅에 **「GitHub에 올렸어」**

---

## 방법 3 — 로컬 복사 + git (오류 확인)

```powershell
cd C:\Users\user\Documents\arbitrage-betting

# 복사
mkdir extension-legacy -Force
Copy-Item "C:\Users\user\Downloads\arb_v297\arb_v294\*" "extension-legacy\" -Recurse -Force

# 확인
dir extension-legacy

# git
git status
git add extension-legacy
git commit -m "add extension"
git push origin cursor/arbitrage-betting-00df
```

### push 가 실패할 때

| 오류 | 해결 |
|------|------|
| `not a git repository` | `git clone` 먼저 |
| `Permission denied` | GitHub 로그인 / 토큰 |
| `rejected` | `git pull` 후 다시 push |
| 파일 너무 큼 | popup.js만 나눠서 채팅에 붙여넣기 |

---

## 방법 4 — 진단 스크립트

```powershell
cd C:\Users\user\Documents\arbitrage-betting
git pull origin cursor/arbitrage-betting-00df
.\scripts\check-extension-upload.ps1
```

나온 결과를 **채팅에 복사**해 주세요.

---

## 방법 5 — 구글 드라이브 / 카카오톡

1. `arb_v294` 폴더 zip
2. 드라이브나 PC톡으로 **본인에게** 전송
3. Cursor에서 **그 zip을 채팅에 다시 첨부** 시도

안 되면 zip 말고 **방법 1 (붙여넣기)**.

---

## 최소만내도 시작 가능

이 3개만 있어도 BTI 수정 시작 가능:

- `manifest.json`
- `bti_content.js`
- `background.js`

나머지는 나중에 추가해도 됩니다.

---

## 지금 바로 해주실 것

**가장 쉬운 것:**  
`manifest.json` 이랑 `bti_content.js` 내용을 메모장에서 복사해서 **이 채팅에 붙여넣기**.
