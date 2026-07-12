from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Optional

from ..models.match import MatchOdds

logger = logging.getLogger(__name__)


class SiteAdapter(ABC):
  """배팅 사이트 어댑터 기본 클래스."""

  def __init__(self, name: str, base_url: str = "", username: str = "", password: str = ""):
    self.name = name
    self.base_url = base_url
    self.username = username
    self.password = password
    self._logged_in = False

  @abstractmethod
  async def connect(self) -> bool:
    """사이트에 연결 (로그인 등)."""

  @abstractmethod
  async def disconnect(self) -> None:
    """연결 해제."""

  @abstractmethod
  async def fetch_odds(self, sports: list[str] | None = None) -> list[MatchOdds]:
    """실시간 배당 조회."""

  @abstractmethod
  async def place_bet(
    self,
    match_id: str,
    outcome: str,
    odds: float,
    stake: float,
    market_type: str = "moneyline",
    line: Optional[float] = None,
  ) -> dict:
    """배팅 실행. 성공 시 bet_id 등 정보 반환."""

  @abstractmethod
  async def get_balance(self) -> float:
    """잔액 조회."""

  @property
  def is_connected(self) -> bool:
    return self._logged_in
