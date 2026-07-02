from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional, Union

from ..utils.match_matcher import match_key
from ..models.arbitrage import ArbitrageOpportunity, BetAllocation
from ..models.match import Match, MatchOdds
from ..models.odds import MarketType, Outcome

logger = logging.getLogger(__name__)


class ArbitrageCalculator:
  """양방배팅(차익거래) 계산기."""

  def __init__(self, min_profit_margin: float = 0.5, total_stake: float = 100_000):
    self.min_profit_margin = min_profit_margin
    self.total_stake = total_stake

  def find_opportunities(
    self,
    site_a_odds: list[MatchOdds],
    site_b_odds: list[MatchOdds],
  ) -> list[ArbitrageOpportunity]:
    """두 사이트의 배당을 비교하여 양방배팅 기회를 탐색.

    사이트별 match_id가 다르므로 팀명 기반 match_key로 매칭합니다.
    """
    opportunities: list[ArbitrageOpportunity] = []

    a_index = self._index_by_match_key(site_a_odds)
    b_index = self._index_by_match_key(site_b_odds)

    common_keys = set(a_index.keys()) & set(b_index.keys())
    logger.debug("공통 경기 %d건 매칭", len(common_keys))

    for key in common_keys:
      for a_odds in a_index[key]:
        for b_odds in b_index[key]:
          if a_odds.market_type != b_odds.market_type:
            continue
          if a_odds.market_type == MarketType.OVER_UNDER:
            if a_odds.line != b_odds.line:
              continue

          opp = self._check_match(a_odds, b_odds)
          if opp and opp.profit_margin >= self.min_profit_margin:
            opportunities.append(opp)

    opportunities.sort(key=lambda o: o.profit_margin, reverse=True)
    return opportunities

  def _index_by_match_key(
    self, odds_list: list[MatchOdds]
  ) -> dict[str, list[MatchOdds]]:
    index: dict[str, list[MatchOdds]] = {}
    for mo in odds_list:
      key = match_key(mo.match.home_team, mo.match.away_team, mo.match.sport)
      index.setdefault(key, []).append(mo)
    return index

  def _check_match(
    self, a_odds: MatchOdds, b_odds: MatchOdds
  ) -> Optional[ArbitrageOpportunity]:
    if a_odds.market_type == MarketType.MONEYLINE:
      return self._check_moneyline(a_odds, b_odds)
    if a_odds.market_type == MarketType.OVER_UNDER:
      return self._check_over_under(a_odds, b_odds)
    return None

  def _check_moneyline(
    self, a_odds: MatchOdds, b_odds: MatchOdds
  ) -> Optional[ArbitrageOpportunity]:
    """승무패 마켓 양방배팅 검사."""
    outcomes_a = {o.outcome: o for o in a_odds.odds}
    outcomes_b = {o.outcome: o for o in b_odds.odds}

    all_outcomes = set(outcomes_a.keys()) | set(outcomes_b.keys())

    # 2-way: 각 결과를 서로 다른 사이트에서 최고 배당 선택
    if Outcome.DRAW not in all_outcomes:
      return self._calc_two_way(
        match=a_odds.match,
        market_type=MarketType.MONEYLINE,
        combos=[
          (outcomes_a.get(Outcome.HOME), outcomes_b.get(Outcome.AWAY)),
          (outcomes_b.get(Outcome.HOME), outcomes_a.get(Outcome.AWAY)),
        ],
      )

    # 3-way: 홈/무/원 각각 A/B 사이트 배분 조합 탐색 (2^3 = 8가지)
    best: Optional[ArbitrageOpportunity] = None
    sources = [outcomes_a, outcomes_b]
    three_outcomes = [Outcome.HOME, Outcome.DRAW, Outcome.AWAY]

    from itertools import product

    for choices in product([0, 1], repeat=3):
      selected = []
      valid = True
      for outcome, choice in zip(three_outcomes, choices):
        o = sources[choice].get(outcome)
        if o is None:
          valid = False
          break
        selected.append(o)
      if not valid:
        continue

      opp = self._calc_from_odds_list(a_odds.match, MarketType.MONEYLINE, selected)
      if opp and (best is None or opp.profit_margin > best.profit_margin):
        best = opp

    return best

  def _check_over_under(
    self, a_odds: MatchOdds, b_odds: MatchOdds
  ) -> Optional[ArbitrageOpportunity]:
    """오버/언더 마켓 양방배팅 검사."""
    if a_odds.line != b_odds.line:
      return None

    outcomes_a = {o.outcome: o for o in a_odds.odds}
    outcomes_b = {o.outcome: o for o in b_odds.odds}

    return self._calc_two_way(
      match=a_odds.match,
      market_type=MarketType.OVER_UNDER,
      line=a_odds.line,
      combos=[
        (outcomes_a.get(Outcome.OVER), outcomes_b.get(Outcome.UNDER)),
        (outcomes_b.get(Outcome.OVER), outcomes_a.get(Outcome.UNDER)),
      ],
    )

  def _calc_two_way(
    self,
    match: Match,
    market_type: MarketType,
    combos: list[tuple],
    line: Optional[float] = None,
  ) -> Optional[ArbitrageOpportunity]:
    best: Optional[ArbitrageOpportunity] = None

    for odds_a, odds_b in combos:
      if odds_a is None or odds_b is None:
        continue
      opp = self._calc_from_odds_list(match, market_type, [odds_a, odds_b], line)
      if opp and (best is None or opp.profit_margin > best.profit_margin):
        best = opp

    return best

  def _calc_from_odds_list(
    self,
    match: Match,
    market_type: MarketType,
    odds_list: list,
    line: Optional[float] = None,
  ) -> Optional[ArbitrageOpportunity]:
    implied_sum = sum(o.implied_probability for o in odds_list)

    if implied_sum >= 1.0:
      return None

    profit_margin = (1.0 - implied_sum) * 100

    allocations: list[BetAllocation] = []
    for o in odds_list:
      stake = self.total_stake * o.implied_probability / implied_sum
      allocations.append(
        BetAllocation(
          site=o.site,
          outcome=o.outcome,
          odds=o.value,
          stake=round(stake, 0),
          potential_return=round(stake * o.value, 0),
        )
      )

    actual_total = sum(a.stake for a in allocations)
    guaranteed_profit = allocations[0].potential_return - actual_total

    return ArbitrageOpportunity(
      match=match,
      market_type=market_type,
      allocations=allocations,
      profit_margin=round(profit_margin, 4),
      total_stake=actual_total,
      guaranteed_profit=round(guaranteed_profit, 0),
      line=line,
    )

  def calc_optimal_stakes(
    self, odds_values: list[float], total: float
  ) -> list[float]:
    """주어진 배당에 대한 최적 배팅 금액 계산."""
    implied = [1.0 / o for o in odds_values]
    total_implied = sum(implied)
    return [round(total * i / total_implied, 0) for i in implied]
