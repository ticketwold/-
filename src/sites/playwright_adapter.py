from __future__ import annotations

import logging
from typing import Optional

from ..models.match import MatchOdds
from .base import SiteAdapter

logger = logging.getLogger(__name__)


class PlaywrightSiteAdapter(SiteAdapter):
  """Playwright 기반 실제 사이트 어댑터 템플릿.

  실제 사이트에 맞게 fetch_odds, place_bet 메서드를 구현하세요.
  사이트별 CSS 셀렉터와 로그인 절차가 다르므로 하위 클래스로 확장합니다.
  """

  def __init__(self, name: str, **kwargs):
    super().__init__(name, **kwargs)
    self._browser = None
    self._page = None

  async def connect(self) -> bool:
    try:
      from playwright.async_api import async_playwright

      self._playwright = await async_playwright().start()
      self._browser = await self._playwright.chromium.launch(headless=True)
      self._page = await self._browser.new_page()

      if self.base_url:
        await self._page.goto(self.base_url)

      if self.username and self.password:
        await self._login()

      self._logged_in = True
      logger.info("[%s] Playwright 연결 완료", self.name)
      return True
    except Exception as e:
      logger.error("[%s] 연결 실패: %s", self.name, e)
      return False

  async def _login(self) -> None:
    """사이트별 로그인 구현 - 하위 클래스에서 오버라이드."""
    raise NotImplementedError(
      f"{self.name}: 로그인 로직을 구현하세요. "
      "사이트의 로그인 폼 셀렉터에 맞게 작성이 필요합니다."
    )

  async def disconnect(self) -> None:
    if self._browser:
      await self._browser.close()
    if hasattr(self, "_playwright") and self._playwright:
      await self._playwright.stop()
    self._logged_in = False

  async def fetch_odds(self, sports: list[str] | None = None) -> list[MatchOdds]:
    """사이트별 배당 스크래핑 - 하위 클래스에서 오버라이드."""
    raise NotImplementedError(
      f"{self.name}: fetch_odds를 구현하세요. "
      "사이트의 배당 페이지 구조에 맞는 셀렉터가 필요합니다."
    )

  async def place_bet(
    self,
    match_id: str,
    outcome: str,
    odds: float,
    stake: float,
    market_type: str = "moneyline",
    line: Optional[float] = None,
  ) -> dict:
    """사이트별 배팅 실행 - 하위 클래스에서 오버라이드."""
    raise NotImplementedError(
      f"{self.name}: place_bet을 구현하세요."
    )

  async def get_balance(self) -> float:
    raise NotImplementedError(f"{self.name}: get_balance를 구현하세요.")
