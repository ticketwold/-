from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional, Union

from ..models.arbitrage import ArbitrageOpportunity
from ..sites.base import SiteAdapter
from .calculator import ArbitrageCalculator

logger = logging.getLogger(__name__)


class OddsMonitor:
  """실시간 배당 모니터링 엔진."""

  def __init__(
    self,
    site_a: SiteAdapter,
    site_b: SiteAdapter,
    calculator: ArbitrageCalculator,
    poll_interval: float = 2.0,
    sports: list[str] | None = None,
    on_opportunity: Optional[
      Callable[[ArbitrageOpportunity], Union[None, Awaitable[None]]]
    ] = None,
  ):
    self.site_a = site_a
    self.site_b = site_b
    self.calculator = calculator
    self.poll_interval = poll_interval
    self.sports = sports
    self.on_opportunity = on_opportunity
    self._running = False
    self._scan_count = 0
    self._opportunities_found = 0

  async def start(self) -> None:
    """모니터링 시작."""
    import asyncio

    self._running = True
    logger.info(
      "모니터링 시작 (간격: %.1f초, 최소수익률: %.2f%%)",
      self.poll_interval,
      self.calculator.min_profit_margin,
    )

    while self._running:
      try:
        await self._scan()
      except Exception as e:
        logger.error("스캔 오류: %s", e)

      await asyncio.sleep(self.poll_interval)

  def stop(self) -> None:
    self._running = False
    logger.info(
      "모니터링 종료 (총 %d회 스캔, %d건 기회 발견)",
      self._scan_count,
      self._opportunities_found,
    )

  async def scan_once(self) -> list[ArbitrageOpportunity]:
    """단일 스캔 실행."""
    return await self._scan()

  async def _scan(self) -> list[ArbitrageOpportunity]:
    import asyncio

    self._scan_count += 1

    odds_a, odds_b = await asyncio.gather(
      self.site_a.fetch_odds(self.sports),
      self.site_b.fetch_odds(self.sports),
    )

    opportunities = self.calculator.find_opportunities(odds_a, odds_b)

    if opportunities:
      self._opportunities_found += len(opportunities)
      for opp in opportunities:
        logger.info("양방배팅 기회 발견!\n%s", opp.summary())
        if self.on_opportunity:
          result = self.on_opportunity(opp)
          if asyncio.iscoroutine(result):
            await result

    return opportunities

  @property
  def stats(self) -> dict:
    return {
      "scan_count": self._scan_count,
      "opportunities_found": self._opportunities_found,
      "running": self._running,
    }
