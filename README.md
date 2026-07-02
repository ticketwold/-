# 양방배팅 (Arbitrage Betting) 자동화 프로그램

A사이트와 B사이트의 배당을 실시간으로 비교하여, 양방배팅 조건에 맞으면 자동으로 배팅을 실행하는 프로그램입니다.

## 주요 기능

- **실시간 배당 모니터링**: 두 사이트의 배당을 주기적으로 비교
- **양방배팅 자동 탐지**: 수익률이 설정값 이상일 때 기회 자동 감지
- **최적 배팅금 계산**: 확정 수익을 위한 사이트별 배팅 금액 자동 산출
- **자동 배팅 실행**: 조건 충족 시 양쪽 사이트에 동시 배팅
- **드라이런 모드**: 실제 배팅 없이 시뮬레이션 가능
- **확장 가능한 어댑터**: 사이트별 커스텀 연동 지원

## 양방배팅 원리

두 사이트의 배당을 조합하여 **어떤 결과가 나와도 수익**이 나도록 배팅하는 전략입니다.

```
수익 조건: (1/배당A) + (1/배당B) < 1

예시:
  A사이트 홈승 2.10  →  B사이트 원정승 2.10
  합산 확률: 1/2.10 + 1/2.10 = 0.952 < 1  ✓ 양방 가능
  수익률: (1 - 0.952) × 100 = 4.8%
```

## 프로젝트 구조

```
├── config/
│   └── settings.yaml.example   # 설정 파일 예시
├── src/
│   ├── main.py                 # CLI 진입점
│   ├── config.py               # 설정 로더
│   ├── models/                 # 데이터 모델
│   ├── core/
│   │   ├── calculator.py       # 양방배팅 계산기
│   │   ├── monitor.py          # 실시간 모니터링
│   │   └── executor.py         # 자동 배팅 실행
│   └── sites/
│       ├── base.py             # 사이트 어댑터 인터페이스
│       ├── mock.py             # 테스트용 Mock 어댑터
│       └── playwright_adapter.py  # 실제 사이트 연동 템플릿
└── tests/
```

## 설치

```bash
pip install -r requirements.txt

# 실제 사이트 연동 시 (Playwright)
playwright install chromium
```

## 사용법

### 1. 설정 파일 준비

```bash
cp config/settings.yaml.example config/settings.yaml
# settings.yaml 에서 사이트 정보, 수익률 기준 등 수정
```

### 2. 양방배팅 계산기 (수동)

```bash
python -m src.main calc 2.10 2.10 --stake 100000
```

### 3. 1회 스캔

```bash
python -m src.main scan
```

### 4. 실시간 모니터링 + 자동 배팅

```bash
# 드라이런 (시뮬레이션)
python -m src.main monitor --dry-run

# 옵션 지정
python -m src.main monitor --interval 3 --min-profit 1.0 --dry-run
```

## 설정 항목

| 항목 | 설명 | 기본값 |
|------|------|--------|
| `poll_interval` | 배당 조회 간격 (초) | 2.0 |
| `min_profit_margin` | 최소 수익률 (%) | 0.5 |
| `total_stake` | 총 투자 금액 (원) | 100,000 |
| `dry_run` | 시뮬레이션 모드 | true |
| `max_concurrent_bets` | 최대 동시 배팅 수 | 3 |

## 실제 사이트 연동 방법

현재는 Mock 어댑터로 동작합니다. 실제 A/B 사이트를 연동하려면:

### 1. Playwright 어댑터 확장

`src/sites/` 에 사이트별 클래스를 생성합니다:

```python
from .playwright_adapter import PlaywrightSiteAdapter

class SiteAAdapter(PlaywrightSiteAdapter):
    async def _login(self):
        await self._page.fill("#username", self.username)
        await self._page.fill("#password", self.password)
        await self._page.click("#login-btn")

    async def fetch_odds(self, sports=None):
        # 사이트의 배당 페이지에서 데이터 추출
        ...

    async def place_bet(self, match_id, outcome, odds, stake, **kwargs):
        # 배팅 슬립에 금액 입력 후 확인
        ...
```

### 2. 설정 변경

```yaml
site_a:
  adapter: playwright
  base_url: "https://your-site-a.com"
  username: "your_id"
  password: "your_password"
```

### 3. 경기 매칭

두 사이트의 경기명이 다를 수 있으므로, 팀명 정규화/매칭 로직 추가가 필요합니다.

## 주의사항

- **법적 리스크**: 자동 배팅은 일부 국가/사이트에서 불법이거나 약관 위반일 수 있습니다.
- **계정 제한**: 양방배팅이 감지되면 계정이 제한될 수 있습니다.
- **배당 변동**: 배팅 실행 중 배당이 변경되면 손실이 발생할 수 있습니다.
- **반쪽 배팅**: 한쪽만 배팅 성공 시 헷징 로직이 필요합니다 (현재 미구현).
- **반드시 드라이런으로 충분히 테스트**한 후 실제 배팅을 진행하세요.

## 테스트

```bash
pip install -r requirements-dev.txt
pytest tests/ -v
```

## 라이선스

MIT
