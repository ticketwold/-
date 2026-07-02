from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class MarketType(str, Enum):
  MONEYLINE = "moneyline"
  OVER_UNDER = "over_under"


class Outcome(str, Enum):
  HOME = "home"
  AWAY = "away"
  DRAW = "draw"
  OVER = "over"
  UNDER = "under"


class Odds(BaseModel):
  """단일 배당 정보."""

  outcome: Outcome
  value: float = Field(gt=1.0, description="배당률 (1.0 초과)")
  site: str
  market_type: MarketType = MarketType.MONEYLINE
  line: Optional[float] = Field(default=None, description="오버/언더 기준점")

  @property
  def implied_probability(self) -> float:
    return 1.0 / self.value
