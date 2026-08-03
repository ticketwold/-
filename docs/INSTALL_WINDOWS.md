# Windows 설치 및 실행 가이드 (완전판)

이 문서는 **처음부터 끝까지** 양방배팅 프로그램을 Windows PC에서 실행하는 방법을 설명합니다.

---

## 목차

1. [필요한 것](#1-필요한-것)
2. [Python 설치](#2-python-설치)
3. [Git 설치 (프로젝트 다운로드용)](#3-git-설치)
4. [프로젝트 다운로드](#4-프로젝트-다운로드)
5. [가상환경 생성 (권장)](#5-가상환경-생성-권장)
6. [패키지 설치](#6-패키지-설치)
7. [Playwright 브라우저 설치](#7-playwright-브라우저-설치)
8. [설정 파일 만들기](#8-설정-파일-만들기)
9. [pbc00 계정 설정](#9-pbc00-계정-설정)
10. [실행 명령어 모음](#10-실행-명령어-모음)
11. [문제 해결](#11-문제-해결)

---

## 1. 필요한 것

| 항목 | 설명 |
|------|------|
| Windows 10/11 | 64비트 |
| 인터넷 연결 | Pinnacle, pbc00 접속용 |
| pbc00 계정 | 아이디/비밀번호 |
| Pinnacle | 계정 없어도 배당 조회 가능 (API) |
| 약 500MB 디스크 | Python + 브라우저 |

---

## 2. Python 설치

### 2-1. 다운로드

1. 브라우저에서 접속: https://www.python.org/downloads/
2. **Download Python 3.12.x** (또는 3.11 이상) 클릭
3. 설치 파일 실행

### 2-2. 설치 시 반드시 체크

```
☑ Add python.exe to PATH   ← 이것 꼭 체크!
```

그 다음 **Install Now** 클릭

### 2-3. 설치 확인

**PowerShell**을 엽니다 (시작 메뉴 → "PowerShell" 검색)

```powershell
python --version
```

아래처럼 나오면 성공:
```
Python 3.12.x
```

`python`이 안 되면:
```powershell
py --version
```

---

## 3. Git 설치

### 3-1. 다운로드

1. https://git-scm.com/download/win 접속
2. **64-bit Git for Windows Setup** 다운로드 후 설치
3. 설치 옵션은 기본값 그대로 **Next** 연속 클릭

### 3-2. 확인

```powershell
git --version
```

```
git version 2.x.x
```

---

## 4. 프로젝트 다운로드

PowerShell에서 실행:

```powershell
# 원하는 폴더로 이동 (예: 문서 폴더)
cd C:\Users\user\Documents

# 프로젝트 다운로드
git clone https://github.com/ticketwold/-.git arbitrage-betting

# 프로젝트 폴더로 이동
cd arbitrage-betting
```

> 이미 ZIP으로 받았다면, 압축 해제 후 그 폴더로 `cd` 하세요.

### 폴더 구조 확인

```powershell
dir
```

아래 파일/폴더가 보여야 합니다:
```
config/
src/
scripts/
requirements.txt
README.md
```

---

## 5. 가상환경 생성 (권장)

프로젝트 폴더에서:

```powershell
# 가상환경 생성
python -m venv venv

# 가상환경 활성화
.\venv\Scripts\Activate.ps1
```

활성화되면 프롬프트 앞에 `(venv)`가 표시됩니다:
```
(venv) PS C:\Users\user\Documents\arbitrage-betting>
```

> **오류**: "스크립트 실행이 금지되어 있습니다" 나오면:
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```
> 입력 후 Y → 다시 `.\venv\Scripts\Activate.ps1` 실행

---

## 6. 패키지 설치

가상환경이 활성화된 상태에서:

```powershell
# pip 업그레이드
python -m pip install --upgrade pip

# 필수 패키지 설치
pip install -r requirements.txt

# 개발/테스트 패키지 (선택)
pip install -r requirements-dev.txt
```

설치되는 패키지:
- `aiohttp` - Pinnacle API 통신
- `playwright` - pbc00 브라우저 자동화
- `rich` - 화면 출력
- `click` - CLI 명령어
- `pydantic`, `pyyaml` - 설정 파일

---

## 7. Playwright 브라우저 설치

pbc00 접속에 필요한 Chromium 브라우저 설치:

```powershell
playwright install chromium
```

약 100MB 다운로드됩니다. 완료까지 1~3분 소요.

---

## 8. 설정 파일 만들기

### 방법 1: PowerShell 명령

```powershell
Copy-Item config\settings.yaml.example config\settings.yaml
```

### 방법 2: setup 스크립트

```powershell
.\scripts\setup.ps1
```

### 설정 파일 위치

```
config\settings.yaml
```

메모장으로 열어서 수정합니다:

```powershell
notepad config\settings.yaml
```

---

## 9. pbc00 계정 설정

`config\settings.yaml` 파일에서 아래 부분을 수정:

```yaml
site_b:
  name: "PBC00"
  adapter: pbc00
  base_url: "https://pbc00.com"
  gamecode: "19"
  game_child_seq: "3659"
  headless: false                              # ← false 유지 (브라우저 창 표시)
  cookies_path: "config/pbc00_session.json"    # ← 로그인 세션 저장 경로
  username: "여기에_pbc00_아이디"               # ← 본인 아이디
  password: "여기에_pbc00_비밀번호"             # ← 본인 비밀번호
```

### gamecode / game_child_seq 란?

pbc00 URL에서 가져옵니다:
```
https://pbc00.com/game/newDetail/0?gamecode=19&game_child_seq=3659&event=N
                                        ↑                    ↑
                                   gamecode          game_child_seq
```

스포츠 종목 페이지 URL의 값을 그대로 넣으면 됩니다.

---

## 10. 실행 명령어 모음

**모든 명령은 프로젝트 폴더에서, 가상환경 활성화 후 실행하세요.**

```powershell
cd C:\Users\user\Documents\arbitrage-betting
.\venv\Scripts\Activate.ps1
```

---

### 10-1. 설치 확인 (가장 먼저 실행)

```powershell
python -m src.main --help
```

명령어 목록이 나오면 설치 성공.

---

### 10-2. Pinnacle 배당만 확인 (연결 테스트)

```powershell
python -m src.main pinnacle --sport football --limit 10
```

실시간 축구 배당 10건이 표로 출력되면 Pinnacle 연동 성공.

---

### 10-3. Mock 가상배팅 (연습용, 계정 불필요)

```powershell
python -m src.main virtual-test --scans 5
```

가짜 사이트로 양방배팅 시뮬레이션. 프로그램 동작 확인용.

---

### 10-4. pbc00 사이트 구조 탐색 (최초 1회)

```powershell
python -m src.main discover
```

- Chrome 브라우저가 열립니다
- pbc00 로그인 (자동 또는 수동)
- `config\pbc00_selectors.json` 파일 생성됨
- API URL, DOM 셀렉터 정보 저장

---

### 10-5. 실제 가상배팅 (핵심 기능)

```powershell
python -m src.main virtual-test-real --scans 5
```

| 단계 | 동작 |
|------|------|
| 1 | Pinnacle API에서 실시간 배당 조회 |
| 2 | pbc00 브라우저에서 배당 스크래핑 |
| 3 | 같은 경기 자동 매칭 |
| 4 | 양방배팅 기회 발견 시 가상배팅 시뮬레이션 |
| 5 | **실제 돈은 나가지 않음** (dry_run) |

---

### 10-6. 1회 스캔 (양방 기회만 확인)

```powershell
python -m src.main scan
```

---

### 10-7. 실시간 모니터링 (자동 반복)

```powershell
python -m src.main monitor --dry-run --interval 5 --min-profit 0.5
```

| 옵션 | 설명 |
|------|------|
| `--dry-run` | 가상배팅만 (실제 배팅 안 함) |
| `--interval 5` | 5초마다 배당 조회 |
| `--min-profit 0.5` | 수익률 0.5% 이상일 때만 |

종료: `Ctrl + C`

---

### 10-8. 수동 양방배팅 계산기

```powershell
python -m src.main calc 2.10 2.05 --stake 100000
```

A사이트 2.10, B사이트 2.05 배당일 때 최적 배팅금 계산.

---

## 11. 문제 해결

### `python` 명령을 찾을 수 없음

```powershell
py -m src.main --help
```

또는 Python 재설치 시 **Add to PATH** 체크.

---

### `cp` 명령 오류 (PowerShell)

Windows에서는 `cp` 대신:
```powershell
Copy-Item config\settings.yaml.example config\settings.yaml
```

---

### `config` 폴더를 찾을 수 없음

프로젝트 폴더가 아닌 곳에서 실행한 것입니다:
```powershell
cd C:\Users\user\Documents\arbitrage-betting
```

---

### pbc00 Cloudflare 차단

1. `headless: false` 확인
2. `username`, `password` 입력
3. `discover` 명령으로 먼저 로그인 세션 저장
4. VPN 사용 중이면 끄고 재시도

---

### pbc00 배당 0개

1. `discover` 실행 후 `config\pbc00_selectors.json` 확인
2. `gamecode`, `game_child_seq` URL 값과 일치하는지 확인
3. pbc00 사이트에서 해당 스포츠 페이지가 열리는지 브라우저로 직접 확인

---

### playwright install 오류

```powershell
python -m playwright install chromium
```

---

## 빠른 시작 (한 번에 복사)

아래를 PowerShell에 **순서대로** 붙여넣기:

```powershell
# 1. 프로젝트 폴더로 이동 (경로 수정)
cd C:\Users\user\Documents\arbitrage-betting

# 2. 가상환경 활성화
.\venv\Scripts\Activate.ps1

# 3. 설정 파일 (최초 1회)
Copy-Item config\settings.yaml.example config\settings.yaml

# 4. Pinnacle 연결 테스트
python -m src.main pinnacle --sport football --limit 5

# 5. 실제 가상배팅 (settings.yaml에 pbc00 계정 입력 후)
python -m src.main virtual-test-real --scans 3
```

---

## 실행 순서 요약

```
① Python 설치 (PATH 체크)
      ↓
② Git 설치
      ↓
③ 프로젝트 clone
      ↓
④ venv 생성 + 활성화
      ↓
⑤ pip install -r requirements.txt
      ↓
⑥ playwright install chromium
      ↓
⑦ settings.yaml 생성 + pbc00 계정 입력
      ↓
⑧ python -m src.main pinnacle  (연결 테스트)
      ↓
⑨ python -m src.main discover  (pbc00 탐색, 최초 1회)
      ↓
⑩ python -m src.main virtual-test-real  (실제 가상배팅)
```

---

## 주의사항

- **dry_run: true** 기본값 → 실제 배팅 없음
- 실제 배팅 전 반드시 가상배팅으로 충분히 테스트
- 자동 배팅은 사이트 약관 위반 및 계정 제한 위험 있음
- `config\settings.yaml`에 비밀번호가 들어가므로 타인과 공유 금지
