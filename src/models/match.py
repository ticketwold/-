from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from .odds import MarketType, Odds


class Match(BaseModel):
  """경기 정보."""

  match_id: str
  sport: str
  home_team: str
  away_team: str
  league: str = ""
  start_time: Optional[datetime] = None

  @property
  def display_name(self) -> str:
    return f"{self.home_team} vs {self.away_team}"


class MatchOdds(BaseModel):
  """한 경기의 사이트별 배당 모음."""

  match: Match
  site: str
  market_type: MarketType
  odds: list[Odds] = Field(default_factory=list)
  line: Optional[float] = None
  updated_at: datetime = Field(default_factory=datetime.now)

  def get_odds(self, outcome) -> Optional[Odds]:
    from .odds import Outcome

    for o in self.odds:
      if o.outcome == outcome:
        return o
    return None

  def best_odds_for(self, outcome) -> Optional[float]:
    odds = self.get_odds(outcome)
    return odds.value if odds else None
