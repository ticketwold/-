from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

import aiohttp

from ..models.match import Match, MatchOdds
from ..models.odds import MarketType, Odds, Outcome
from ..utils.odds_convert import american_to_decimal
from .base import SiteAdapter

logger = logging.getLogger(__name__)

SPORT_IDS = {
  "football": 29,
  "soccer": 29,
  "basketball": 4,
  "tennis": 33,
}

API_BASE = "https://guest.api.arcadia.pinnacle.com/0.1"
CONFIG_URL = "https://www.pinnacle.com/config/app.json"


class PinnacleAdapter(SiteAdapter):
  """Pinnacle 게스트 API 기반 어댑터.

  API 키는 pinnacle.com/config/app.json 에서 자동 획득합니다.
  배당은 미국식(american)에서 유럽식(decimal)으로 변환됩니다.
  """

  def __init__(
    self,
    name: str = "Pinnacle",
    skip_live: bool = True,
    league_filter: list[str] | None = None,
    **kwargs,
  ):
    super().__init__(name, **kwargs)
    self.skip_live = skip_live
    self.league_filter = league_filter or []
    self._session: aiohttp.ClientSession | None = None
    self._api_key: str = ""
    self._balance = 0.0

  async def connect(self) -> bool:
    try:
      self._session = aiohttp.ClientSession()
      async with self._session.get(CONFIG_URL) as resp:
        config = await resp.json()
        self._api_key = config["api"]["haywire"]["apiKey"]

      self._logged_in = True
      logger.info("[%s] API 연결 완료", self.name)
      return True
    except Exception as e:
      logger.error("[%s] 연결 실패: %s", self.name, e)
      return False

  async def disconnect(self) -> None:
    if self._session:
      await self._session.close()
      self._session = None
    self._logged_in = False

  def _headers(self) -> dict:
    return {
      "x-api-key": self._api_key,
      "Accept": "application/json",
      "Referer": "https://www.pinnacle.com/",
    }

  async def fetch_odds(self, sports: list[str] | None = None) -> list[MatchOdds]:
    if not self._session:
      return []

    target_sports = sports or list(SPORT_IDS.keys())
    sport_ids = list({
      SPORT_IDS[s] for s in target_sports if s in SPORT_IDS
    })

    results: list[MatchOdds] = []
    for sport_id in sport_ids:
      sport_odds = await self._fetch_sport(sport_id)
      results.extend(sport_odds)

    logger.debug("[%s] %d개 마켓 조회", self.name, len(results))
    return results

  async def _fetch_sport(self, sport_id: int) -> list[MatchOdds]:
    assert self._session

    matchups_url = f"{API_BASE}/sports/{sport_id}/matchups?withSpecials=false&brandId=0"
    markets_url = f"{API_BASE}/sports/{sport_id}/markets/straight"

    async with self._session.get(matchups_url, headers=self._headers()) as resp:
      matchups = await resp.json()
    async with self._session.get(markets_url, headers=self._headers()) as resp:
      markets = await resp.json()

    matchup_map = self._build_matchup_map(matchups)
    return self._parse_markets(markets, matchup_map, sport_id)

  def _build_matchup_map(self, matchups: list) -> dict:
    """matchupId → 경기 정보 매핑."""
    result = {}
    for m in matchups:
      if m.get("type") != "matchup":
        continue
      if not m.get("hasMarkets"):
        continue
      if self.skip_live and m.get("isLive"):
        continue

      league_name = m.get("league", {}).get("name", "")
      if self.league_filter and not any(
        f.lower() in league_name.lower() for f in self.league_filter
      ):
        continue

      participants = m.get("participants", [])
      if not participants:
        parent = m.get("parent") or {}
        participants = parent.get("participants", [])

      home = away = None
      for p in participants:
        if p.get("alignment") == "home":
          home = p["name"]
        elif p.get("alignment") == "away":
          away = p["name"]

      if not home or not away:
        continue

      sport_name = m.get("league", {}).get("sport", {}).get("name", "")
      sport_key = "football" if sport_name == "Soccer" else sport_name.lower()

      start_time = None
      if m.get("startTime"):
        try:
          start_time = datetime.fromisoformat(
            m["startTime"].replace("Z", "+00:00")
          )
        except ValueError:
          pass

      result[m["id"]] = {
        "home": home,
        "away": away,
        "league": league_name,
        "sport": sport_key,
        "start_time": start_time,
      }

    return result

  def _parse_markets(
    self, markets: list, matchup_map: dict, sport_id: int
  ) -> list[MatchOdds]:
    results: list[MatchOdds] = []

    ml_by_matchup: dict[int, dict] = {}
    total_by_matchup: dict[int, dict] = {}

    for mk in markets:
      if mk.get("period") != 0:
        continue

      mid = mk["matchupId"]
      if mid not in matchup_map:
        continue

      mtype = mk.get("type")
      if mtype == "moneyline":
        ml_by_matchup[mid] = mk
      elif mtype == "total":
        total_by_matchup[mid] = mk

    for mid, info in matchup_map.items():
      match = Match(
        match_id=f"pinnacle_{mid}",
        sport=info["sport"],
        home_team=info["home"],
        away_team=info["away"],
        league=info["league"],
        start_time=info["start_time"],
      )

      if mid in ml_by_matchup:
        ml_odds = self._parse_moneyline(ml_by_matchup[mid], match)
        if ml_odds:
          results.append(ml_odds)

      if mid in total_by_matchup:
        ou_odds = self._parse_total(total_by_matchup[mid], match)
        if ou_odds:
          results.append(ou_odds)

    return results

  def _parse_moneyline(self, market: dict, match: Match) -> MatchOdds | None:
    odds_list: list[Odds] = []
    for p in market.get("prices", []):
      designation = p.get("designation", "")
      decimal = american_to_decimal(p["price"])

      outcome_map = {
        "home": Outcome.HOME,
        "away": Outcome.AWAY,
        "draw": Outcome.DRAW,
      }
      outcome = outcome_map.get(designation)
      if not outcome:
        continue

      odds_list.append(
        Odds(
          outcome=outcome,
          value=decimal,
          site=self.name,
          market_type=MarketType.MONEYLINE,
        )
      )

    if len(odds_list) < 2:
      return None

    return MatchOdds(
      match=match,
      site=self.name,
      market_type=MarketType.MONEYLINE,
      odds=odds_list,
    )

  def _parse_total(self, market: dict, match: Match) -> MatchOdds | None:
    odds_list: list[Odds] = []
    line = None

    for p in market.get("prices", []):
      designation = p.get("designation", "")
      points = p.get("points")
      if points is not None:
        line = points
      decimal = american_to_decimal(p["price"])

      if designation == "over":
        odds_list.append(
          Odds(
            outcome=Outcome.OVER,
            value=decimal,
            site=self.name,
            market_type=MarketType.OVER_UNDER,
            line=line,
          )
        )
      elif designation == "under":
        odds_list.append(
          Odds(
            outcome=Outcome.UNDER,
            value=decimal,
            site=self.name,
            market_type=MarketType.OVER_UNDER,
            line=line,
          )
        )

    if len(odds_list) < 2 or line is None:
      return None

    return MatchOdds(
      match=match,
      site=self.name,
      market_type=MarketType.OVER_UNDER,
      line=line,
      odds=odds_list,
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
    """Pinnacle 배팅은 계정 로그인 + 공식 API 또는 브라우저 자동화가 필요합니다."""
    logger.warning(
      "[%s] 자동 배팅은 Playwright 로그인 세션 구현이 필요합니다. "
      "현재는 수동 배팅을 권장합니다.",
      self.name,
    )
    return {
      "status": "not_implemented",
      "message": "Pinnacle 자동 배팅은 로그인 세션 구현 후 사용 가능",
      "match_id": match_id,
      "outcome": outcome,
      "odds": odds,
      "stake": stake,
    }

  async def get_balance(self) -> float:
    return self._balance
