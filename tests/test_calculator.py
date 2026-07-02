"""양방배팅 계산기 테스트."""

import pytest

from src.core.calculator import ArbitrageCalculator
from src.models.match import Match, MatchOdds
from src.models.odds import MarketType, Odds, Outcome


@pytest.fixture
def calculator():
  return ArbitrageCalculator(min_profit_margin=0.1, total_stake=100_000)


@pytest.fixture
def sample_match():
  return Match(
    match_id="test_001",
    sport="football",
    home_team="Team A",
    away_team="Team B",
    league="Test League",
  )


class TestArbitrageCalculator:
  def test_calc_optimal_stakes(self, calculator):
    stakes = calculator.calc_optimal_stakes([2.1, 2.1], 100_000)
    assert sum(stakes) == pytest.approx(100_000, abs=1)
    assert stakes[0] == stakes[1]

  def test_no_arbitrage_when_sum_exceeds_one(self, calculator, sample_match):
    a_odds = MatchOdds(
      match=sample_match,
      site="SiteA",
      market_type=MarketType.MONEYLINE,
      odds=[
        Odds(outcome=Outcome.HOME, value=1.9, site="SiteA"),
        Odds(outcome=Outcome.AWAY, value=1.9, site="SiteA"),
      ],
    )
    b_odds = MatchOdds(
      match=sample_match,
      site="SiteB",
      market_type=MarketType.MONEYLINE,
      odds=[
        Odds(outcome=Outcome.HOME, value=1.9, site="SiteB"),
        Odds(outcome=Outcome.AWAY, value=1.9, site="SiteB"),
      ],
    )
    opps = calculator.find_opportunities([a_odds], [b_odds])
    assert len(opps) == 0

  def test_arbitrage_detected(self, calculator, sample_match):
    a_odds = MatchOdds(
      match=sample_match,
      site="SiteA",
      market_type=MarketType.MONEYLINE,
      odds=[
        Odds(outcome=Outcome.HOME, value=2.2, site="SiteA"),
        Odds(outcome=Outcome.AWAY, value=1.7, site="SiteA"),
      ],
    )
    b_odds = MatchOdds(
      match=sample_match,
      site="SiteB",
      market_type=MarketType.MONEYLINE,
      odds=[
        Odds(outcome=Outcome.HOME, value=1.7, site="SiteB"),
        Odds(outcome=Outcome.AWAY, value=2.2, site="SiteB"),
      ],
    )
    opps = calculator.find_opportunities([a_odds], [b_odds])
    assert len(opps) == 1
    assert opps[0].profit_margin > 0
    assert opps[0].guaranteed_profit > 0
    assert len(opps[0].allocations) == 2

  def test_over_under_arbitrage(self, calculator, sample_match):
    a_odds = MatchOdds(
      match=sample_match,
      site="SiteA",
      market_type=MarketType.OVER_UNDER,
      line=2.5,
      odds=[
        Odds(
          outcome=Outcome.OVER,
          value=2.05,
          site="SiteA",
          market_type=MarketType.OVER_UNDER,
          line=2.5,
        ),
        Odds(
          outcome=Outcome.UNDER,
          value=1.75,
          site="SiteA",
          market_type=MarketType.OVER_UNDER,
          line=2.5,
        ),
      ],
    )
    b_odds = MatchOdds(
      match=sample_match,
      site="SiteB",
      market_type=MarketType.OVER_UNDER,
      line=2.5,
      odds=[
        Odds(
          outcome=Outcome.OVER,
          value=1.75,
          site="SiteB",
          market_type=MarketType.OVER_UNDER,
          line=2.5,
        ),
        Odds(
          outcome=Outcome.UNDER,
          value=2.05,
          site="SiteB",
          market_type=MarketType.OVER_UNDER,
          line=2.5,
        ),
      ],
    )
    opps = calculator.find_opportunities([a_odds], [b_odds])
    assert len(opps) == 1
    assert opps[0].market_type == MarketType.OVER_UNDER

  def test_min_profit_margin_filter(self, sample_match):
    strict_calc = ArbitrageCalculator(min_profit_margin=10.0, total_stake=100_000)
    a_odds = MatchOdds(
      match=sample_match,
      site="SiteA",
      market_type=MarketType.MONEYLINE,
      odds=[
        Odds(outcome=Outcome.HOME, value=2.05, site="SiteA"),
        Odds(outcome=Outcome.AWAY, value=1.95, site="SiteA"),
      ],
    )
    b_odds = MatchOdds(
      match=sample_match,
      site="SiteB",
      market_type=MarketType.MONEYLINE,
      odds=[
        Odds(outcome=Outcome.HOME, value=1.95, site="SiteB"),
        Odds(outcome=Outcome.AWAY, value=2.05, site="SiteB"),
      ],
    )
    opps = strict_calc.find_opportunities([a_odds], [b_odds])
    assert len(opps) == 0
