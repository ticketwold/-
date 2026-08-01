from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Optional

from ..models.arbitrage import ArbitrageOpportunity, BetAllocation
from ..sites.base import SiteAdapter

logger = logging.getLogger(__name__)


class BetExecutor:
  """양방배팅 자동 실행 엔진."""

  def __init__(
    self,
    site_a: SiteAdapter,
    site_b: SiteAdapter,
    dry_run: bool = True,
    max_concurrent_bets: int = 3,
  ):
    self.site_a = site_a
    self.site_b = site_b
    self.dry_run = dry_run
    self.max_concurrent_bets = max_concurrent_bets
    self._active_bets: list[dict] = []
    self._bet_history: list[dict] = []
    self._site_map = {site_a.name: site_a, site_b.name: site_b}

  async def execute(self, opportunity: ArbitrageOpportunity) -> dict:
    """양방배팅 기회를 실행."""
    if len(self._active_bets) >= self.max_concurrent_bets:
      logger.warning("최대 동시 배팅 수 초과 - 스킵")
      return {"status": "skipped", "reason": "max_concurrent_bets"}

    if self._is_duplicate(opportunity):
      logger.debug("중복 기회 - 스킵: %s", opportunity.match.display_name)
      return {"status": "skipped", "reason": "duplicate"}

    if self.dry_run:
      return self._simulate(opportunity)

    return await self._execute_real(opportunity)

  def _is_duplicate(self, opportunity: ArbitrageOpportunity) -> bool:
    for bet in self._active_bets:
      if bet["match_id"] == opportunity.match.match_id:
        return True
    return False

  def _simulate(self, opportunity: ArbitrageOpportunity) -> dict:
    result = {
      "status": "simulated",
      "match": opportunity.match.display_name,
      "profit_margin": opportunity.profit_margin,
      "guaranteed_profit": opportunity.guaranteed_profit,
      "total_stake": opportunity.total_stake,
      "bets": [],
      "timestamp": datetime.now().isoformat(),
    }

    for alloc in opportunity.allocations:
      result["bets"].append({
        "site": alloc.site,
        "outcome": alloc.outcome.value,
        "odds": alloc.odds,
        "stake": alloc.stake,
      })
      logger.info(
        "[DRY-RUN] %s: %s @ %.2f (%s원)",
        alloc.site,
        alloc.outcome.value,
        alloc.odds,
        alloc.stake,
      )

    self._bet_history.append(result)
    logger.info(
      "[DRY-RUN] %s | 수익률 %.2f%% | 확정수익 %s원",
      opportunity.match.display_name,
      opportunity.profit_margin,
      f"{opportunity.guaranteed_profit:,.0f}",
    )
    return result

  async def _execute_real(self, opportunity: ArbitrageOpportunity) -> dict:
    """실제 배팅 실행 - 양쪽 사이트에 동시 배팅."""
    tasks = []
    for alloc in opportunity.allocations:
      site = self._site_map.get(alloc.site)
      if not site:
        logger.error("알 수 없는 사이트: %s", alloc.site)
        return {"status": "failed", "reason": f"unknown site: {alloc.site}"}
      tasks.append(self._place_single(site, opportunity, alloc))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    failures = [r for r in results if isinstance(r, Exception)]
    if failures:
      logger.error("배팅 실패: %s", failures)
      # TODO: 성공한 쪽 배팅 취소(헷징) 로직
      return {"status": "partial_failure", "results": results}

    bet_record = {
      "status": "executed",
      "match_id": opportunity.match.match_id,
      "match": opportunity.match.display_name,
      "profit_margin": opportunity.profit_margin,
      "guaranteed_profit": opportunity.guaranteed_profit,
      "results": results,
      "timestamp": datetime.now().isoformat(),
    }
    self._active_bets.append(bet_record)
    self._bet_history.append(bet_record)

    logger.info(
      "양방배팅 완료: %s | 수익률 %.2f%%",
      opportunity.match.display_name,
      opportunity.profit_margin,
    )
    return bet_record

  async def _place_single(
    self,
    site: SiteAdapter,
    opportunity: ArbitrageOpportunity,
    alloc: BetAllocation,
  ) -> dict:
    return await site.place_bet(
      match_id=opportunity.match.match_id,
      outcome=alloc.outcome.value,
      odds=alloc.odds,
      stake=alloc.stake,
      market_type=opportunity.market_type.value,
      line=opportunity.line,
    )

  @property
  def history(self) -> list[dict]:
    return self._bet_history

  @property
  def active_count(self) -> int:
    return len(self._active_bets)
