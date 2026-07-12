# 양방배팅 (Arbitrage Betting)

**Pinnacle** + **pbc00 BTI** 배당을 비교해 양방 기회를 찾습니다.

## ★ 추천: 브라우저 확장 프로그램

Python/venv 없이 **Edge 확장만**으로 사용할 수 있습니다.

| 폴더 | 용도 |
|------|------|
| **`extension-legacy/`** | 기존 전체 확장 (v2.98, Pinnacle+BTI+SBO 양방) — **추천** |
| `extension/` | 간소화 버전 (Pinnacle + pbc00 DOM 스캔) |

```powershell
git pull origin cursor/arbitrage-betting-00df
# edge://extensions → 개발자 모드 → extension-legacy 폴더 로드
```

자세한 사용법: [extension-legacy/README.md](extension-legacy/README.md)

1. 확장 아이콘 → **pbc00 열기** → 로그인
2. BTI 경기/배당 화면에서 **양방 스캔**

---

## Python CLI (선택)

**Pinnacle** (A)과 **pbc00.com** (B) Playwright 자동화 버전입니다.

## 연동 사이트

| 사이트 | 어댑터 | 방식 | 상태 |
|--------|--------|------|------|
| [Pinnacle](https://www.pinnacle.com/ko/) | `pinnacle` | Guest API (자동) | ✅ 동작 확인 |
| [pbc00.com](https://pbc00.com) | `pbc00` | Playwright (브라우저) | ⚠️ 로컬 PC 필요 |

## 주요 기능

- **실시간 배당 모니터링**: Pinnacle API + pbc00 브라우저 스크래핑
- **크로스 사이트 경기 매칭**: 팀명 정규화로 사이트 간 동일 경기 자동 매칭
- **양방배팅 자동 탐지**: 2-way, 3-way, 오버/언더 마켓 지원
- **최적 배팅금 계산**: 확정 수익을 위한 사이트별 배팅 금액 자동 산출
- **드라이런 모드**: 실제 배팅 없이 시뮬레이션

## 설치

### Windows

```powershell
# 1. 프로젝트 폴더로 이동 (git clone 한 위치)
cd C:\Users\user\경로\프로젝트폴더

# 2. 설정 파일 생성 (아래 중 하나)
Copy-Item config\settings.yaml.example config\settings.yaml
# 또는
.\scripts\setup.ps1

# 3. 패키지 설치
pip install -r requirements.txt
pip install -r requirements-dev.txt
playwright install chromium
```

### macOS / Linux

```bash
cd /path/to/project
cp config/settings.yaml.example config/settings.yaml
pip install -r requirements.txt
pip install -r requirements-dev.txt
playwright install chromium
```

> **주의**: `cp` 또는 `Copy-Item`은 **프로젝트 루트 폴더**에서 실행해야 합니다.
> `C:\Users\user` 같은 홈 폴더에서는 `config` 폴더가 없어 오류가 납니다.

## 사용법

### Pinnacle 배당 확인

```bash
python3 -m src.main pinnacle --sport football --limit 10
```

### 1회 양방 스캔 (Pinnacle vs pbc00)

```bash
python3 -m src.main scan
```

### 실시간 모니터링

```bash
python3 -m src.main monitor --dry-run --min-profit 0.5
```

### pbc00 사이트 구조 탐색 (로컬 PC)

```bash
python3 -m src.main discover
```

## 설정 (`config/settings.yaml`)

```yaml
site_a:
  name: "Pinnacle"
  adapter: pinnacle
  base_url: "https://www.pinnacle.com/ko/"
  skip_live: true
  league_filter: []  # 예: ["EPL", "NBA"]

site_b:
  name: "PBC00"
  adapter: pbc00
  base_url: "https://pbc00.com"
  gamecode: "19"
  game_child_seq: "3659"
  headless: false
  cookies_path: "config/pbc00_session.json"
  username: "your_id"
  password: "your_password"
```

## pbc00.com 연동 가이드

pbc00.com은 **Cloudflare 보호**가 있어 서버 환경에서는 접근이 차단됩니다. **로컬 PC에서** 아래 순서로 설정하세요.

### 1단계: 사이트 구조 탐색

```bash
python3 -m src.main discover
```

`config/pbc00_selectors.json`에 API URL과 DOM 셀렉터가 저장됩니다.

### 2단계: 로그인 세션 저장

1. `headless: false`로 설정
2. `username`, `password` 입력
3. `discover` 또는 `scan` 실행 시 브라우저가 열리면 로그인
4. 세션이 `config/pbc00_session.json`에 자동 저장

### 3단계: 셀렉터 조정

탐색 결과를 보고 `settings.yaml`의 `selectors`를 실제 사이트에 맞게 수정:

```yaml
selectors:
  match_row: ".실제-경기-행-셀렉터"
  home_team: ".홈팀-셀렉터"
  away_team: ".원정팀-셀렉터"
  odds_home: ".홈배당-셀렉터"
```

## Pinnacle API

- API 키는 `pinnacle.com/config/app.json`에서 자동 획득
- 미국식 배당 → 유럽식(소수) 배당 자동 변환
- 축구(29), 농구(4) 등 스포츠 ID 자동 매핑
- 자동 배팅은 계정 로그인 세션 구현 후 가능 (현재 수동 배팅 권장)

## 양방배팅 원리

```
수익 조건: (1/배당A) + (1/배당B) < 1

예시:
  Pinnacle 홈승 2.10  +  PBC00 원정승 2.10
  합산: 1/2.10 + 1/2.10 = 0.952 < 1  →  수익률 4.8%
```

## 테스트

```bash
python3 -m pytest tests/ -v
```

## 주의사항

- 자동 배팅은 사이트 약관 위반 및 **계정 제한** 위험이 있습니다
- Pinnacle은 양방배팅에 관대하지만, pbc00은 제한될 수 있습니다
- 배팅 실행 중 배당 변경 시 손실 가능
- **반드시 dry_run으로 테스트** 후 실제 배팅 진행

## 라이선스

MIT
