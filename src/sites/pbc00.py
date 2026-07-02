from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlencode, urlparse, parse_qs

from ..models.match import Match, MatchOdds
from ..models.odds import MarketType, Odds, Outcome
from .base import SiteAdapter

logger = logging.getLogger(__name__)


class Pbc00Adapter(SiteAdapter):
  """pbc00.com Playwright 기반 어댑터.

  Cloudflare 보호가 있어 로컬 PC에서 실행하거나
  cookies_path에 저장된 로그인 세션을 사용해야 합니다.

  URL 예시:
    https://pbc00.com/game/newDetail/0?gamecode=19&game_child_seq=3659&event=N
  """

  DEFAULT_SELECTORS = {
    "login_open": (
      "a:has-text('로그인'), button:has-text('로그인'), "
      ".btn-login, #login, .login-btn, [href*='login']"
    ),
    "login_id": (
      "input[name='id'], input[name='userId'], input[name='userid'], "
      "input[name='username'], input[name='memberId'], "
      "#userId, #userid, #id, #username, .login-id, "
      "input[placeholder*='아이디'], input[placeholder*='ID']"
    ),
    "login_pw": (
      "input[name='password'], input[name='pw'], input[name='passwd'], "
      "#password, #pw, #passwd, .login-pw, "
      "input[type='password'], input[placeholder*='비밀번호']"
    ),
    "login_btn": (
      "button[type='submit'], input[type='submit'], "
      "button:has-text('로그인'), .btn-login-submit, #loginBtn, #btnLogin"
    ),
    "match_row": ".game-list .item, .match-item, .game-row, tr.game",
    "home_team": ".home-team, .team-home, .home .name",
    "away_team": ".away-team, .team-away, .away .name",
    "odds_home": ".odds-home, .home .odds, [data-bet='home']",
    "odds_away": ".odds-away, .away .odds, [data-bet='away']",
    "odds_draw": ".odds-draw, .draw .odds, [data-bet='draw']",
    "bet_slip": ".bet-slip, .betslip, #betSlip",
    "stake_input": "input[name='stake'], input.bet-amount, #betAmount",
    "bet_confirm": ".btn-bet, .confirm-bet, #placeBet",
    # 10벳 진입 버튼/메뉴 (사이트마다 다를 수 있음)
    "tenbet_entry": (
      "a:has-text('10벳'), button:has-text('10벳'), "
      "a:has-text('10BET'), button:has-text('10BET'), "
      "a:has-text('10bet'), .tenbet, .btn-10bet, "
      "[data-provider='10bet'], [data-game='10bet']"
    ),
  }

  DEFAULT_NAV_TEXTS = ["10벳", "10BET", "10bet", "10 벳", "텐벳"]

  def __init__(
    self,
    name: str = "PBC00",
    gamecode: str = "19",
    game_child_seq: str = "3659",
    event: str = "N",
    page_url: str = "",
    cookies_path: str = "",
    headless: bool = False,
    manual_login: bool = True,
    login_url: str = "",
    login_wait_seconds: int = 120,
    selectors: dict[str, str] | None = None,
    navigation_texts: list[str] | None = None,
    **kwargs,
  ):
    super().__init__(name, **kwargs)
    self.gamecode = gamecode
    self.game_child_seq = game_child_seq
    self.event = event
    self.page_url = page_url
    self.cookies_path = cookies_path
    self.headless = headless
    self.manual_login = manual_login
    self.login_url = login_url or f"{self.base_url.rstrip('/')}/main" if self.base_url else "https://pbc00.com/main"
    self.login_wait_seconds = login_wait_seconds
    self.selectors = {**self.DEFAULT_SELECTORS, **(selectors or {})}
    self.navigation_texts = navigation_texts or self.DEFAULT_NAV_TEXTS
    self._browser = None
    self._page = None
    self._playwright = None
    self._captured_api_data: list[dict] = []
    self._balance = 0.0

  def _build_url(self, event: str | None = None) -> str:
    if self.page_url:
      return self.page_url
    params = {
      "gamecode": self.gamecode,
      "game_child_seq": self.game_child_seq,
      "event": event or self.event,
    }
    base = self.base_url.rstrip("/") if self.base_url else "https://pbc00.com"
    return f"{base}/game/newDetail/0?{urlencode(params)}"

  async def connect(self) -> bool:
    try:
      from playwright.async_api import async_playwright

      self._playwright = await async_playwright().start()
      self._browser = await self._playwright.chromium.launch(
        headless=self.headless,
        args=[
          "--disable-blink-features=AutomationControlled",
          "--no-sandbox",
        ],
      )

      context_kwargs: dict[str, Any] = {
        "user_agent": (
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
          "AppleWebKit/537.36 (KHTML, like Gecko) "
          "Chrome/120.0.0.0 Safari/537.36"
        ),
        "locale": "ko-KR",
        "viewport": {"width": 1920, "height": 1080},
      }

      if self.cookies_path and Path(self.cookies_path).exists():
        context_kwargs["storage_state"] = self.cookies_path
        logger.info("[%s] 저장된 세션 로드: %s", self.name, self.cookies_path)

      context = await self._browser.new_context(**context_kwargs)
      self._page = await context.new_page()

      self._page.on("response", self._on_response)

      # 저장된 세션이 있으면 바로 게임 페이지로
      if self.cookies_path and Path(self.cookies_path).exists():
        url = self._build_url()
        logger.info("[%s] 저장된 세션으로 접속: %s", self.name, url)
        await self._page.goto(url, wait_until="domcontentloaded", timeout=60000)
      else:
        # 로그인 페이지(/main)부터 시작
        logger.info("[%s] 로그인 페이지 접속: %s", self.name, self.login_url)
        await self._page.goto(self.login_url, wait_until="domcontentloaded", timeout=60000)

      await self._page.wait_for_timeout(3000)

      if await self._is_cloudflare_blocked():
        logger.error(
          "[%s] Cloudflare 차단 감지. 로컬 PC에서 실행하거나 "
          "cookies_path에 로그인 세션을 저장하세요.",
          self.name,
        )
        await self.disconnect()
        return False

      logged_in = await self._ensure_logged_in()

      if not logged_in:
        logger.error("[%s] 로그인 실패", self.name)
        await self._save_debug_screenshot("login_failed")
        return False

      # 게임 페이지로 이동
      game_url = self._build_url()
      if self._page.url != game_url:
        logger.info("[%s] 게임 페이지 이동: %s", self.name, game_url)
        await self._page.goto(game_url, wait_until="domcontentloaded", timeout=60000)
        await self._page.wait_for_timeout(2000)

      await self._navigate_to_tenbet()

      self._logged_in = True
      logger.info("[%s] 연결 완료", self.name)
      return True

    except Exception as e:
      logger.error("[%s] 연결 실패: %s", self.name, e)
      return False

  async def _is_cloudflare_blocked(self) -> bool:
    title = await self._page.title()
    if "cloudflare" in title.lower() or "blocked" in title.lower():
      return True
    body = await self._page.inner_text("body")
    return "you have been blocked" in body.lower()

  async def _on_response(self, response) -> None:
    """XHR/Fetch 응답에서 배당 API 데이터 캡처."""
    url = response.url
    keywords = ["odds", "game", "match", "event", "sport", "bet", "detail", "list"]
    if not any(k in url.lower() for k in keywords):
      return
    try:
      ct = response.headers.get("content-type", "")
      if "json" not in ct:
        return
      body = await response.json()
      self._captured_api_data.append({"url": url, "data": body})
      logger.debug("[%s] API 캡처: %s", self.name, url)
    except Exception:
      pass

  async def _ensure_logged_in(self) -> bool:
    """로그인 보장 — 세션 있으면 스킵, 없으면 자동/수동 로그인."""
    if await self._is_logged_in():
      logger.info("[%s] 이미 로그인됨", self.name)
      await self._save_session()
      return True

    if self.manual_login:
      return await self._manual_login_wait()

    if self.username and self.password:
      success = await self._auto_login()
      if success:
        await self._save_session()
        return True

    logger.warning("[%s] 자동 로그인 실패 → 수동 로그인 대기", self.name)
    return await self._manual_login_wait()

  async def _is_logged_in(self) -> bool:
    """로그인 상태 확인."""
    page = self._page
    logout_keywords = ["로그아웃", "logout", "Logout", "마이페이지", "충전", "출금"]
    for target in self._active_pages():
      try:
        body = await target.inner_text("body")
        for kw in logout_keywords:
          if kw in body:
            return True
      except Exception:
        pass

    # 로그인 폼이 없으면 로그인된 것으로 간주
    for target in self._active_pages():
      try:
        pw_count = await target.locator("input[type='password']").count()
        id_selectors = self.selectors["login_id"].split(", ")
        id_count = 0
        for sel in id_selectors:
          id_count += await target.locator(sel.strip()).count()
        if pw_count == 0 and id_count == 0:
          return True
      except Exception:
        pass

    return False

  async def _open_login_form(self) -> None:
    """로그인 버튼 클릭하여 로그인 폼 열기."""
    for target in self._active_pages():
      for sel in self.selectors.get("login_open", "").split(", "):
        sel = sel.strip()
        if not sel:
          continue
        try:
          loc = target.locator(sel)
          if await loc.count() > 0:
            await loc.first.click(timeout=3000)
            await self._page.wait_for_timeout(1500)
            logger.info("[%s] 로그인 폼 열기: %s", self.name, sel)
            return
        except Exception:
          pass

      for text in ["로그인", "LOGIN", "Login"]:
        try:
          loc = target.get_by_text(text, exact=True)
          if await loc.count() > 0:
            await loc.first.click(timeout=3000)
            await self._page.wait_for_timeout(1500)
            return
        except Exception:
          pass

  async def _auto_login(self) -> bool:
    """자동 로그인 시도."""
    logger.info("[%s] 자동 로그인 시도...", self.name)
    await self._open_login_form()
    await self._page.wait_for_timeout(1000)

    filled_id = await self._fill_input(self.selectors["login_id"], self.username)
    filled_pw = await self._fill_input(self.selectors["login_pw"], self.password)

    if not filled_id or not filled_pw:
      logger.warning("[%s] 로그인 입력창을 찾지 못함 (id=%s, pw=%s)", self.name, filled_id, filled_pw)
      await self._save_debug_screenshot("login_form_not_found")
      return False

    clicked = await self._click_selector(self.selectors["login_btn"])
    if not clicked:
      # Enter 키로 제출 시도
      for target in self._active_pages():
        try:
          await target.locator("input[type='password']").first.press("Enter")
          break
        except Exception:
          pass

    await self._page.wait_for_timeout(4000)
    return await self._is_logged_in()

  async def _manual_login_wait(self) -> bool:
    """브라우저에서 사용자가 직접 로그인할 때까지 대기."""
    print()
    print("=" * 55)
    print("  [PBC00] 브라우저에서 직접 로그인해 주세요!")
    print("  1) 아이디 / 비밀번호 입력")
    print("  2) 로그인 버튼 클릭")
    print(f"  3) 최대 {self.login_wait_seconds}초 대기합니다...")
    print("=" * 55)
    print()

    await self._open_login_form()

    interval = 2
    elapsed = 0
    while elapsed < self.login_wait_seconds:
      if await self._is_logged_in():
        logger.info("[%s] 수동 로그인 성공!", self.name)
        await self._save_session()
        return True
      await self._page.wait_for_timeout(interval * 1000)
      elapsed += interval
      if elapsed % 10 == 0:
        print(f"  ... 로그인 대기 중 ({elapsed}/{self.login_wait_seconds}초)")

    logger.error("[%s] 로그인 시간 초과", self.name)
    return False

  async def _fill_input(self, selector_str: str, value: str) -> bool:
    """메인 페이지 + iframe에서 입력창 찾아 입력."""
    for target in self._active_pages():
      for sel in selector_str.split(", "):
        sel = sel.strip()
        if not sel:
          continue
        try:
          loc = target.locator(sel)
          if await loc.count() > 0:
            await loc.first.click(timeout=3000)
            await loc.first.fill(value, timeout=3000)
            return True
        except Exception:
          pass
    return False

  async def _click_selector(self, selector_str: str) -> bool:
    for target in self._active_pages():
      for sel in selector_str.split(", "):
        sel = sel.strip()
        if not sel:
          continue
        try:
          loc = target.locator(sel)
          if await loc.count() > 0:
            await loc.first.click(timeout=5000)
            return True
        except Exception:
          pass
    return False

  async def _save_session(self) -> None:
    if self.cookies_path and self._page:
      Path(self.cookies_path).parent.mkdir(parents=True, exist_ok=True)
      await self._page.context.storage_state(path=self.cookies_path)
      logger.info("[%s] 로그인 세션 저장: %s", self.name, self.cookies_path)

  async def _save_debug_screenshot(self, name: str) -> None:
    try:
      Path("config").mkdir(exist_ok=True)
      path = f"config/pbc00_{name}.png"
      await self._page.screenshot(path=path, full_page=True)
      logger.info("[%s] 스크린샷 저장: %s", self.name, path)
    except Exception:
      pass

  async def _login(self) -> None:
    """레거시 — _ensure_logged_in 사용."""
    await self._ensure_logged_in()

  async def _navigate_to_tenbet(self) -> bool:
    """10벳 스포츠북 메뉴 진입 — 경기 목록이 표시되는 화면으로 이동."""
    page = self._page
    logger.info("[%s] 10벳 메뉴 진입 시도...", self.name)

    # 1) CSS 셀렉터로 클릭
    tenbet_sel = self.selectors.get("tenbet_entry", "")
    for sel in tenbet_sel.split(", "):
      sel = sel.strip()
      if not sel:
        continue
      try:
        loc = page.locator(sel)
        if await loc.count() > 0:
          await loc.first.click(timeout=5000)
          await page.wait_for_timeout(3000)
          logger.info("[%s] 10벳 진입 (셀렉터: %s)", self.name, sel)
          await self._wait_for_match_content()
          return True
      except Exception as e:
        logger.debug("[%s] 셀렉터 실패 %s: %s", self.name, sel, e)

    # 2) 텍스트로 클릭 (메인 페이지 + iframe)
    for text in self.navigation_texts:
      clicked = await self._click_by_text(text)
      if clicked:
        logger.info("[%s] 10벳 진입 (텍스트: %s)", self.name, text)
        await self._wait_for_match_content()
        return True

    # 3) iframe 내부 탐색
    for frame in page.frames:
      if frame == page.main_frame:
        continue
      for text in self.navigation_texts:
        try:
          loc = frame.get_by_text(text, exact=False)
          if await loc.count() > 0:
            await loc.first.click(timeout=5000)
            await page.wait_for_timeout(3000)
            logger.info("[%s] 10벳 진입 (iframe, 텍스트: %s)", self.name, text)
            await self._wait_for_match_content()
            return True
        except Exception:
          pass

    logger.warning(
      "[%s] 10벳 메뉴를 찾지 못했습니다. "
      "settings.yaml 의 selectors.tenbet_entry 를 확인하세요.",
      self.name,
    )
    return False

  async def _click_by_text(self, text: str) -> bool:
    """페이지 및 iframe에서 텍스트 클릭."""
    page = self._page
    targets = [page] + [f for f in page.frames if f != page.main_frame]

    for target in targets:
      try:
        loc = target.get_by_text(text, exact=False)
        if await loc.count() > 0:
          await loc.first.click(timeout=5000)
          await page.wait_for_timeout(2000)
          return True
      except Exception:
        pass

      try:
        loc = target.get_by_role("link", name=re.compile(text, re.I))
        if await loc.count() > 0:
          await loc.first.click(timeout=5000)
          await page.wait_for_timeout(2000)
          return True
      except Exception:
        pass

    return False

  async def _wait_for_match_content(self, timeout_ms: int = 15000) -> None:
    """경기 목록 또는 배당 요소가 로드될 때까지 대기."""
    page = self._page
    wait_selectors = [
      self.selectors.get("match_row", "").split(", ")[0],
      ".odds", "[class*='odds']", "[class*='match']",
      "table", ".game-list", ".event",
    ]
    for sel in wait_selectors:
      if not sel or not sel.strip():
        continue
      try:
        await page.wait_for_selector(sel.strip(), timeout=timeout_ms)
        logger.debug("[%s] 콘텐츠 로드 확인: %s", self.name, sel)
        return
      except Exception:
        pass

    await page.wait_for_timeout(3000)

  def _active_pages(self) -> list:
    """스크래핑 대상 페이지 목록 (메인 + iframe)."""
    if not self._page:
      return []
    return [self._page] + [f for f in self._page.frames if f != self._page.main_frame]

  async def disconnect(self) -> None:
    if self._browser:
      await self._browser.close()
    if self._playwright:
      await self._playwright.stop()
    self._logged_in = False

  async def fetch_odds(self, sports: list[str] | None = None) -> list[MatchOdds]:
    if not self._page:
      return []

    self._captured_api_data.clear()

    url = self._build_url()
    await self._page.goto(url, wait_until="domcontentloaded", timeout=60000)
    await self._page.wait_for_timeout(2000)

    if self.username and self.password:
      await self._login()

    await self._navigate_to_tenbet()
    await self._page.wait_for_timeout(3000)

    # 페이지 스크린샷 (디버그용)
    try:
      Path("config").mkdir(exist_ok=True)
      await self._page.screenshot(path="config/pbc00_debug.png", full_page=True)
      logger.debug("[%s] 스크린샷 저장: config/pbc00_debug.png", self.name)
    except Exception:
      pass

    # 1) API 캡처 데이터에서 파싱 시도
    api_results = self._parse_api_data()
    if api_results:
      logger.info("[%s] API에서 %d개 마켓 파싱", self.name, len(api_results))
      return api_results

    # 2) DOM 스크래핑 폴백
    dom_results = await self._scrape_dom()
    if dom_results:
      logger.info("[%s] DOM에서 %d개 마켓 파싱", self.name, len(dom_results))
      return dom_results

    logger.warning("[%s] 배당 데이터를 찾지 못했습니다", self.name)
    return []

  def _parse_api_data(self) -> list[MatchOdds]:
    """캡처된 API 응답에서 배당 파싱 (범용 JSON 탐색)."""
    results: list[MatchOdds] = []

    for captured in self._captured_api_data:
      data = captured["data"]
      items = self._find_match_lists(data)
      for item in items:
        parsed = self._parse_match_item(item)
        if parsed:
          results.append(parsed)

    return results

  def _find_match_lists(self, data: Any, depth: int = 0) -> list[dict]:
    """JSON에서 경기 목록 배열을 재귀 탐색."""
    if depth > 6:
      return []

    if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
      sample = data[0]
      keys = set(sample.keys())
      match_indicators = {
        "homeTeam", "awayTeam", "home_team", "away_team",
        "homeName", "awayName", "teamHome", "teamAway",
        "home", "away", "odds", "homeOdds", "awayOdds",
      }
      if keys & match_indicators:
        return data

    if isinstance(data, dict):
      for value in data.values():
        found = self._find_match_lists(value, depth + 1)
        if found:
          return found

    if isinstance(data, list):
      for item in data:
        found = self._find_match_lists(item, depth + 1)
        if found:
          return found

    return []

  def _parse_match_item(self, item: dict) -> MatchOdds | None:
    """단일 경기 JSON → MatchOdds."""
    home = (
      item.get("homeTeam") or item.get("home_team")
      or item.get("homeName") or item.get("teamHome")
      or (item.get("home") or {}).get("name") if isinstance(item.get("home"), dict) else item.get("home")
    )
    away = (
      item.get("awayTeam") or item.get("away_team")
      or item.get("awayName") or item.get("teamAway")
      or (item.get("away") or {}).get("name") if isinstance(item.get("away"), dict) else item.get("away")
    )

    if not home or not away:
      return None

    home_odds = self._extract_odds(item, "home")
    away_odds = self._extract_odds(item, "away")
    draw_odds = self._extract_odds(item, "draw")

    if not home_odds or not away_odds:
      return None

    match_id = str(item.get("id") or item.get("matchId") or item.get("gameId") or f"pbc_{home}_{away}")
    match = Match(
      match_id=f"pbc00_{match_id}",
      sport="football",
      home_team=str(home),
      away_team=str(away),
      league=str(item.get("league", item.get("leagueName", ""))),
    )

    odds_list = [
      Odds(outcome=Outcome.HOME, value=home_odds, site=self.name),
      Odds(outcome=Outcome.AWAY, value=away_odds, site=self.name),
    ]
    if draw_odds:
      odds_list.append(Odds(outcome=Outcome.DRAW, value=draw_odds, site=self.name))

    return MatchOdds(
      match=match,
      site=self.name,
      market_type=MarketType.MONEYLINE,
      odds=odds_list,
    )

  def _extract_odds(self, item: dict, side: str) -> float | None:
    keys = [
      f"{side}Odds", f"{side}_odds", f"{side}Price", f"{side}_price",
      f"odds{side.capitalize()}", f"odds_{side}",
    ]
    for key in keys:
      val = item.get(key)
      if val is not None:
        return self._to_decimal(float(val))

    odds_obj = item.get("odds", {})
    if isinstance(odds_obj, dict):
      val = odds_obj.get(side)
      if val is not None:
        return self._to_decimal(float(val))

    return None

  def _to_decimal(self, value: float) -> float:
    """배당 형식 자동 변환 (홍콩/유럽/미국)."""
    if value <= 0:
      return 0
    if value < 1.0:
      return round(value + 1, 3)  # 홍콩식
    if value >= 100:
      return round(value / 100 + 1, 3)  # 미국식 양수
    if value <= -100:
      return round(100 / abs(value) + 1, 3)  # 미국식 음수
    return round(value, 3)  # 유럽식

  async def _scrape_dom(self) -> list[MatchOdds]:
    """DOM에서 배당 스크래핑 (메인 페이지 + iframe)."""
    results: list[MatchOdds] = []

    for target in self._active_pages():
      page_results = await self._scrape_dom_from_page(target)
      if page_results:
        results.extend(page_results)
        logger.info("[%s] DOM %d개 마켓 (frame: %s)", self.name, len(page_results), target.url[:60])

    return results

  async def _scrape_dom_from_page(self, page) -> list[MatchOdds]:
    """단일 페이지/iframe에서 배당 스크래핑."""
    results: list[MatchOdds] = []

    for row_sel in self.selectors["match_row"].split(", "):
      rows = page.locator(row_sel)
      count = await rows.count()
      if count == 0:
        continue

      for i in range(count):
        row = rows.nth(i)
        try:
          home = await self._get_text_from_row(row, self.selectors["home_team"])
          away = await self._get_text_from_row(row, self.selectors["away_team"])
          if not home or not away:
            continue

          home_odds = await self._get_odds_from_row(row, self.selectors["odds_home"])
          away_odds = await self._get_odds_from_row(row, self.selectors["odds_away"])
          if not home_odds or not away_odds:
            continue

          match = Match(
            match_id=f"pbc00_dom_{i}",
            sport="football",
            home_team=home,
            away_team=away,
          )
          odds_list = [
            Odds(outcome=Outcome.HOME, value=home_odds, site=self.name),
            Odds(outcome=Outcome.AWAY, value=away_odds, site=self.name),
          ]

          draw_odds = await self._get_odds_from_row(row, self.selectors["odds_draw"])
          if draw_odds:
            odds_list.append(Odds(outcome=Outcome.DRAW, value=draw_odds, site=self.name))

          results.append(MatchOdds(
            match=match,
            site=self.name,
            market_type=MarketType.MONEYLINE,
            odds=odds_list,
          ))
        except Exception as e:
          logger.debug("[%s] 행 파싱 실패: %s", self.name, e)

      if results:
        break

    return results

  async def _get_text_from_row(self, row, selector_str: str) -> str:
    for sel in selector_str.split(", "):
      loc = row.locator(sel)
      if await loc.count() > 0:
        return (await loc.first.inner_text()).strip()
    return ""

  async def _get_odds_from_row(self, row, selector_str: str) -> float | None:
    for sel in selector_str.split(", "):
      loc = row.locator(sel)
      if await loc.count() > 0:
        text = (await loc.first.inner_text()).strip()
        nums = re.findall(r"\d+\.?\d*", text)
        if nums:
          return self._to_decimal(float(nums[0]))
    return None

  async def place_bet(
    self,
    match_id: str,
    outcome: str,
    odds: float,
    stake: float,
    market_type: str = "moneyline",
    line: Optional[float] = None,
  ) -> dict:
    if not self._page:
      return {"status": "failed", "reason": "not connected"}

    try:
      outcome_sel = {
        "home": self.selectors["odds_home"],
        "away": self.selectors["odds_away"],
        "draw": self.selectors["odds_draw"],
      }.get(outcome, "")

      for sel in outcome_sel.split(", "):
        loc = self._page.locator(sel)
        if await loc.count() > 0:
          await loc.first.click()
          break

      await self._page.wait_for_timeout(1000)

      for sel in self.selectors["stake_input"].split(", "):
        loc = self._page.locator(sel)
        if await loc.count() > 0:
          await loc.first.fill(str(int(stake)))
          break

      for sel in self.selectors["bet_confirm"].split(", "):
        loc = self._page.locator(sel)
        if await loc.count() > 0:
          await loc.first.click()
          break

      await self._page.wait_for_timeout(2000)
      logger.info(
        "[%s] 배팅 실행: %s %s @ %.2f (%s원)",
        self.name, match_id, outcome, odds, f"{stake:,.0f}",
      )
      return {"status": "submitted", "match_id": match_id, "stake": stake}

    except Exception as e:
      logger.error("[%s] 배팅 실패: %s", self.name, e)
      return {"status": "failed", "reason": str(e)}

  async def get_balance(self) -> float:
    return self._balance

  async def save_session(self, path: str) -> None:
    """현재 브라우저 세션을 파일로 저장."""
    if self._page:
      await self._page.context.storage_state(path=path)
      logger.info("[%s] 세션 저장 완료: %s", self.name, path)

  async def discover(self, output_path: str = "config/pbc00_selectors.json") -> dict:
    """사이트 구조 탐색 - 로컬에서 셀렉터 확인용."""
    if not self._page:
      return {}

    await self._navigate_to_tenbet()
    await self._page.wait_for_timeout(3000)

    # 10벳 관련 클릭 가능 요소 수집
    clickable_texts: list[str] = []
    for text in self.navigation_texts + ["스포츠", "축구", "Soccer", "Football"]:
      for target in self._active_pages():
        try:
          loc = target.get_by_text(text, exact=False)
          count = await loc.count()
          if count > 0:
            clickable_texts.append(f"{text} (x{count})")
        except Exception:
          pass

    discovery = {
      "url": self._page.url,
      "title": await self._page.title(),
      "frames": [f.url for f in self._page.frames],
      "tenbet_clickable": clickable_texts,
      "api_calls": [
        {"url": c["url"], "sample": json.dumps(c["data"], ensure_ascii=False)[:500]}
        for c in self._captured_api_data[:20]
      ],
      "selectors_found": {},
    }

    for name, sels in self.selectors.items():
      for sel in sels.split(", "):
        count = await self._page.locator(sel).count()
        if count > 0:
          discovery["selectors_found"][name] = {"selector": sel, "count": count}

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
      json.dump(discovery, f, ensure_ascii=False, indent=2)

    logger.info("[%s] 탐색 결과 저장: %s", self.name, output_path)
    return discovery
