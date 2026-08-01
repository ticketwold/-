# 새 PC 설치 가이드 (x10x10s + Polymarket)

**Python 없이** Edge 확장만으로 사용합니다.

---

## 1. 필요한 프로그램

| 프로그램 | 용도 | 다운로드 |
|----------|------|----------|
| **Microsoft Edge** | 브라우저 (기본 설치됨) | — |
| **Git** | 프로젝트 다운로드 | https://git-scm.com/download/win |

> Git 설치 시 옵션은 **기본값(Next)** 그대로 진행하면 됩니다.

설치 확인 (PowerShell):

```powershell
git --version
```

---

## 2. 프로젝트 받기 (파일 위치)

PowerShell을 열고 아래를 **순서대로** 실행합니다.

```powershell
# 문서 폴더로 이동
cd C:\Users\user\Documents

# 프로젝트 다운로드 (폴더명: arbitrage-betting)
git clone https://github.com/ticketwold/-.git arbitrage-betting

# 프로젝트 폴더로 이동
cd arbitrage-betting

# 최신 x10x10 + Polymarket 버전으로 맞추기
git fetch origin cursor/x10-polymarket-00df
git checkout cursor/x10-polymarket-00df
```

### 폴더 구조 (중요)

설치 후 이 경로가 생깁니다:

```
C:\Users\user\Documents\arbitrage-betting\
├── extension-legacy\          ← ★ Edge에 로드할 폴더
│   ├── manifest.json          (버전 4.0.0 확인)
│   ├── background.js
│   ├── popup.html / popup.js
│   ├── bti_content.js         (10벳/BTI)
│   ├── polymarket_content.js  (Polymarket)
│   └── sites_config.js
├── config\
├── docs\
└── README.md
```

**Edge에 로드하는 폴더는 반드시 `extension-legacy` 입니다.**  
상위 `arbitrage-betting` 폴더가 아닙니다.

---

## 3. Edge 확장 프로그램 설치

1. Edge 주소창에 입력: `edge://extensions`
2. 왼쪽 **개발자 모드** 켜기
3. **압축해제된 확장을 로드합니다** 클릭
4. 폴더 선택:

```
C:\Users\user\Documents\arbitrage-betting\extension-legacy
```

5. 로드 후 **버전 4.0.0** 인지 확인
6. 확장 아이콘 → **고정** (툴바에 핀)

---

## 4. 사이트 열기 (매번 사용 전)

### ① x10x10s (10벳 스포츠)

1. https://www.x10x10s.com 접속
2. **로그인**
3. **10벳 / 스포츠** 메뉴 → 배당 버튼이 보이는 화면
4. URL에 `gamecode=19` 등이 있으면 정상 (사이트마다 다를 수 있음)

### ② Polymarket

1. https://polymarket.com 접속
2. (베팅 시) 지갑 연결
3. 서치만 할 때는 로그인 없이도 가능

---

## 5. 확장 사용법

1. 확장 아이콘 클릭
2. 서치 모드: **「10x10 + Polymarket」** (기본값)
3. **🔍 서치 시작** 클릭
4. 슬립 비교: **📋 슬립 비교** 탭 → 양쪽에 배당 담은 뒤 비교

---

## 6. 업데이트 (나중에 버전 올릴 때)

```powershell
cd C:\Users\user\Documents\arbitrage-betting
git fetch origin cursor/x10-polymarket-00df
git reset --hard origin/cursor/x10-polymarket-00df
```

그다음 Edge → `edge://extensions` → 해당 확장 **새로고침** 버튼

---

## 7. 자동 설치 스크립트 (선택)

Git 설치 후, 프로젝트 폴더에서:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-new-pc.ps1
```

끝나면 화면에 로드할 폴더 경로가 출력됩니다.

---

## 8. 문제 해결

| 증상 | 해결 |
|------|------|
| `git` 명령 없음 | Git 재설치 후 PowerShell **새로** 열기 |
| `fatal: not a git repository` | `cd C:\Users\user\Documents\arbitrage-betting` 확인 |
| 확장 로드 실패 | `extension-legacy` 폴더 선택했는지 확인 |
| BTI 0건 | x10x10s 로그인 + 스포츠 배당 화면 |
| Polymarket 0건 | 인터넷/VPN, 방화벽 확인 |
| 예전 pbc00 안내가 나옴 | `git checkout cursor/x10-polymarket-00df` 후 확장 새로고침 |

---

## 한 줄 요약

```
다운로드 → C:\Users\user\Documents\arbitrage-betting
로드 폴더 → C:\Users\user\Documents\arbitrage-betting\extension-legacy
사이트   → x10x10s.com + polymarket.com
```
