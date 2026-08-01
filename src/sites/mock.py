from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime, timedelta

from ..models.match import Match, MatchOdds
from ..models.odds import MarketType, Odds, Outcome
from .base import SiteAdapter

logger = logging.getLogger(__name__)

# 데모용 샘플 경기 데이터
SAMPLE_MATCHES = [
  Match(
    match_id="match_001",
    sport="football",
    home_team="맨체스터 유나이티드",
    away_team="리버풀",
    league="EPL",
    start_time=datetime.now() + timedelta(hours=2),
  ),
  Match(
    match_id="match_002",
    sport="football",
    home_team="바르셀로나",
    away_team="레알 마드리드",
    league="La Liga",
    start_time=datetime.now() + timedelta(hours=4),
  ),
  Match(
    match_id="match_003",
    sport="basketball",
    home_team="LA Lakers",
    away_team="Boston Celtics",
    league="NBA",
    start_time=datetime.now() + timedelta(hours=6),
  ),
]


class MockSiteAdapter(SiteAdapter):
  """테스트/데모용 Mock 사이트 어댑터.

  실제 사이트 연동 전 로직 검증에 사용합니다.
  배당이 주기적으로 변동하여 양방배팅 기회가 발생할 수 있습니다.
  """

  def __init__(
    self,
    name: str,
    bias: float = 0.0,
    **kwargs,
  ):
    super().__init__(name, **kwargs)
    self.bias = bias  # 배당 편향 (사이트 간 차이 시뮬레이션)
    self._balance = 1_000_000.0
    self._bet_counter = 0

  async def connect(self) -> bool:
    await asyncio.sleep(0.1)
    self._logged_in = True
    logger.info("[%s] Mock 연결 완료", self.name)
    return True

  async def disconnect(self) -> None:
    self._logged_in = False
    logger.info("[%s] Mock 연결 해제", self.name)

  async def fetch_odds(self, sports: list[str] | None = None) -> list[MatchOdds]:
    await asyncio.sleep(random.uniform(0.05, 0.2))
    results: list[MatchOdds] = []

    for match in SAMPLE_MATCHES:
      if sports and match.sport not in sports:
        continue

      # 2-way moneyline
      home_odds = self._random_odds(1.8, 2.5) + self.bias
      away_odds = self._random_odds(1.8, 2.5) - self.bias * 0.5

      results.append(
        MatchOdds(
          match=match,
          site=self.name,
          market_type=MarketType.MONEYLINE,
          odds=[
            Odds(outcome=Outcome.HOME, value=home_odds, site=self.name),
            Odds(outcome=Outcome.AWAY, value=away_odds, site=self.name),
          ],
        )
      )

      # over/under
      line = 2.5 if match.sport == "football" else 220.5
      over_odds = self._random_odds(1.85, 2.1) + self.bias
      under_odds = self._random_odds(1.85, 2.1) - self.bias * 0.5

      results.append(
        MatchOdds(
          match=match,
          site=self.name,
          market_type=MarketType.OVER_UNDER,
          line=line,
          odds=[
            Odds(
              outcome=Outcome.OVER,
              value=over_odds,
              site=self.name,
              market_type=MarketType.OVER_UNDER,
              line=line,
            ),
            Odds(
              outcome=Outcome.UNDER,
              value=under_odds,
              site=self.name,
              market_type=MarketType.OVER_UNDER,
              line=line,
            ),
          ],
        )
      )

    return results

  async def place_bet(
    self,
    match_id: str,
    outcome: str,
    odds: float,
    stake: float,
    market_type: str = "moneyline",
    line: float | None = None,
  ) -> dict:
    await asyncio.sleep(random.uniform(0.1, 0.3))
    self._bet_counter += 1
    self._balance -= stake

    bet_id = f"{self.name}_bet_{self._bet_counter}"
    logger.info(
      "[%s] 배팅 완료: %s %s @ %.2f (%s원) → %s",
      self.name,
      match_id,
      outcome,
      odds,
      f"{stake:,.0f}",
      bet_id,
    )
    return {
      "bet_id": bet_id,
      "status": "accepted",
      "stake": stake,
      "odds": odds,
    }

  async def get_balance(self) -> float:
    return self._balance

  def _random_odds(self, low: float, high: float) -> float:
    return round(random.uniform(low, high), 2)
