"""Pinnacle 어댑터 및 경기 매칭 테스트."""

import pytest

from src.core.calculator import ArbitrageCalculator
from src.models.match import Match, MatchOdds
from src.models.odds import MarketType, Odds, Outcome
from src.sites.pinnacle import PinnacleAdapter
from src.utils.match_matcher import match_key, normalize_team
from src.utils.odds_convert import american_to_decimal


class TestOddsConvert:
  def test_american_positive(self):
    assert american_to_decimal(150) == 2.5

  def test_american_negative(self):
    assert american_to_decimal(-150) == 1.667

  def test_american_even(self):
    assert american_to_decimal(100) == 2.0


class TestMatchMatcher:
  def test_normalize_team(self):
    assert normalize_team("Manchester United FC") == "manchester utd"

  def test_match_key_order_independent(self):
    key1 = match_key("Team A", "Team B")
    key2 = match_key("Team B", "Team A")
    assert key1 == key2

  def test_cross_site_matching(self):
    """서로 다른 match_id지만 같은 경기를 매칭."""
    match_a = Match(match_id="pinnacle_123", sport="football", home_team="Barcelona", away_team="Real Madrid")
    match_b = Match(match_id="pbc00_456", sport="football", home_team="FC Barcelona", away_team="Real Madrid CF")

    a_odds = MatchOdds(
      match=match_a, site="Pinnacle", market_type=MarketType.MONEYLINE,
      odds=[
        Odds(outcome=Outcome.HOME, value=2.2, site="Pinnacle"),
        Odds(outcome=Outcome.AWAY, value=1.8, site="Pinnacle"),
      ],
    )
    b_odds = MatchOdds(
      match=match_b, site="PBC00", market_type=MarketType.MONEYLINE,
      odds=[
        Odds(outcome=Outcome.HOME, value=1.7, site="PBC00"),
        Odds(outcome=Outcome.AWAY, value=2.3, site="PBC00"),
      ],
    )

    calc = ArbitrageCalculator(min_profit_margin=0.1, total_stake=100_000)
    opps = calc.find_opportunities([a_odds], [b_odds])
    assert len(opps) == 1
    assert opps[0].profit_margin > 0


@pytest.mark.asyncio
async def test_pinnacle_fetch_odds():
  adapter = PinnacleAdapter()
  connected = await adapter.connect()
  assert connected

  odds = await adapter.fetch_odds(["football"])
  assert len(odds) > 0

  ml = [o for o in odds if o.market_type == MarketType.MONEYLINE]
  assert len(ml) > 0
  for mo in ml:
    assert len(mo.odds) >= 2
    for o in mo.odds:
      assert o.value > 1.0

  await adapter.disconnect()
