from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from .match import Match
from .odds import MarketType, Odds, Outcome


class BetAllocation(BaseModel):
  """각 사이트별 배팅 금액 배분."""

  site: str
  outcome: Outcome
  odds: float
  stake: float
  potential_return: float

  @property
  def profit_if_win(self) -> float:
    return self.potential_return - self.stake


class ArbitrageOpportunity(BaseModel):
  """양방배팅 기회."""

  match: Match
  market_type: MarketType
  allocations: list[BetAllocation]
  profit_margin: float = Field(description="수익률 (%)")
  total_stake: float
  guaranteed_profit: float
  line: Optional[float] = None
  detected_at: datetime = Field(default_factory=datetime.now)

  @property
  def is_profitable(self) -> bool:
    return self.profit_margin > 0

  def summary(self) -> str:
    lines = [
      f"[{self.match.display_name}] {self.market_type.value}",
      f"  수익률: {self.profit_margin:.2f}% | 확정수익: {self.guaranteed_profit:,.0f}원",
    ]
    for alloc in self.allocations:
      lines.append(
        f"  → {alloc.site}: {alloc.outcome.value} @ {alloc.odds:.2f} "
        f"({alloc.stake:,.0f}원)"
      )
    return "\n".join(lines)
