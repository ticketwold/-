from __future__ import annotations

import json
import logging
import re
import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlencode, urlparse, parse_qs

from ..models.match import Match, MatchOdds
from ..models.odds import MarketType, Odds, Outcome
from ..utils.sports import SUPPORTED_SPORT_KEYS, default_sport_pages, get_sport
from ..utils.match_matcher import match_key
from .base import SiteAdapter

logger = logging.getLogger(__name__)

BTI_FRAME_URL_HINTS = ("bti", "sportsbook", "sbk", "asian-view", "/sports")
BTI_API_URL_HINTS = (
  "api", "event", "sport", "market", "odds", "bti", "bet", "line",
  "fixture", "selection", "match", "wager",
)


class Pbc00Adapter(SiteAdapter):
  """pbc00.com Playwright 기반 어댑터.

  Cloudflare 보호가 있어 로컬 PC에서 실행하거나
  cookies_path에 저장된 로그인 세션을 사용해야 합니다.

  URL 예시:
    https://pbc00.com/game/newDetail/0?gamecode=19&game_child_seq=3659&event=N
  """

  DEFAULT_GAME_URL = (
    "https://pbc00.com/game/newDetail/0?gamecode=19&game_child_seq=3659&event=N"
  )

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

  DEFAULT_NAV_TEXTS = [
    "10벳", "10BET", "10bet", "10 벳", "텐벳", "TEN BET", "TenBet",
    "10 BET", "십벳", "스포츠", "Sports",
  ]

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
    manual_tenbet: bool = False,
    skip_tenbet_navigation: bool = True,
    login_url: str = "",
    login_wait_seconds: int = 120,
    tenbet_wait_seconds: int = 120,
    navigation_clicks: list[str] | None = None,
    selectors: dict[str, str] | None = None,
    navigation_texts: list[str] | None = None,
    sport_pages: dict[str, dict] | None = None,
    **kwargs,
  ):
    super().__init__(name, **kwargs)
    self.gamecode = gamecode
    self.game_child_seq = game_child_seq
    self.event = event
    self.page_url = page_url or self.DEFAULT_GAME_URL
    self.sport_pages = self._merge_sport_pages(sport_pages)
    self._current_sport = "football"
    self.cookies_path = cookies_path
    self.headless = headless
    self.manual_login = manual_login
    self.manual_tenbet = manual_tenbet
    self.skip_tenbet_navigation = skip_tenbet_navigation
    self.login_url = login_url  # 비어있으면 게임 URL에서 로그인
    self.login_wait_seconds = login_wait_seconds
    self.tenbet_wait_seconds = tenbet_wait_seconds
    self.navigation_clicks = navigation_clicks or []
    self.selectors = {**self.DEFAULT_SELECTORS, **(selectors or {})}
    self.navigation_texts = navigation_texts or self.DEFAULT_NAV_TEXTS
    self._browser = None
    self._page = None
    self._playwright = None
    self._captured_api_data: list[dict] = []
    self._balance = 0.0

  def _merge_sport_pages(self, overrides: dict[str, dict] | None) -> dict[str, dict]:
    """기본 종목 URL + settings.yaml sport_pages 병합."""
    base_url = self.base_url or "https://pbc00.com"
    merged = default_sport_pages(base_url)

    # 레거시 단일 page_url/gamecode → football에 반영
    if self.page_url and self.page_url != self.DEFAULT_GAME_URL:
      merged["football"]["page_url"] = self.page_url
    if self.gamecode:
      merged["football"]["gamecode"] = self.gamecode
    if self.game_child_seq:
      merged["football"]["game_child_seq"] = self.game_child_seq
    if self.event:
      merged["football"]["event"] = self.event
    if merged["football"]["page_url"]:
      merged["football"]["enabled"] = True

    for sport_key, page_cfg in (overrides or {}).items():
      if sport_key not in merged:
        merged[sport_key] = {
          "enabled": True,
          "gamecode": "",
          "game_child_seq": "",
          "event": "N",
          "page_url": "",
        }
      if isinstance(page_cfg, dict):
        merged[sport_key].update({k: v for k, v in page_cfg.items() if v is not None})
      else:
        merged[sport_key].update(page_cfg.model_dump(exclude_none=True))

    return merged

  def _sport_page_config(self, sport: str) -> dict | None:
    """종목별 페이지 설정. URL이 없으면 None."""
    cfg = self.sport_pages.get(sport)
    if not cfg or not cfg.get("enabled", True):
      return None

    page_url = (cfg.get("page_url") or "").strip()
    gamecode = (cfg.get("gamecode") or "").strip()
    game_child_seq = (cfg.get("game_child_seq") or "").strip()
    event = cfg.get("event") or "N"

    if not page_url and gamecode and game_child_seq:
      base = self.base_url.rstrip("/") if self.base_url else "https://pbc00.com"
      page_url = (
        f"{base}/game/newDetail/0"
        f"?gamecode={gamecode}&game_child_seq={game_child_seq}&event={event}"
      )

    if not page_url:
      return None

    return {
      "gamecode": gamecode,
      "game_child_seq": game_child_seq,
      "event": event,
      "page_url": page_url,
      "nav_texts": self._sport_nav_texts(sport),
    }

  def _sport_nav_texts(self, sport: str) -> list[str]:
    """종목 탭 클릭용 텍스트 (같은 URL 내 종목 전환)."""
    cfg = self.sport_pages.get(sport, {})
    custom = cfg.get("nav_texts") or []
    if custom:
      return list(custom)
    nav_text = (cfg.get("nav_text") or "").strip()
    if nav_text:
      return [nav_text]
    sport_def = get_sport(sport)
    if sport_def and sport_def.pbc00_nav_texts:
      return list(sport_def.pbc00_nav_texts)
    return []

  def _sport_bti_sport_id(self, sport: str) -> str:
    cfg = self.sport_pages.get(sport, {})
    sid = (cfg.get("bti_sport_id") or "").strip()
    if sid:
      return sid
    sport_def = get_sport(sport)
    return sport_def.bti_sport_id if sport_def else ""

  def _is_bti_frame_url(self, url: str) -> bool:
    u = (url or "").lower()
    return any(h in u for h in BTI_FRAME_URL_HINTS)

  def _collect_all_frames(self) -> list:
    """메인 + 중첩 iframe 전체 수집."""
    if not self._page:
      return []
    seen: set[int] = set()
    frames: list = []
    stack = [self._page.main_frame]
    while stack:
      frame = stack.pop()
      fid = id(frame)
      if fid in seen:
        continue
      seen.add(fid)
      frames.append(frame)
      stack.extend(frame.child_frames)
    return frames

  async def _navigate_bti_sport(self, sport: str) -> bool:
    """BTI iframe에 postMessage로 종목 전환 (공식 Communication Layer)."""
    sport_id = self._sport_bti_sport_id(sport)
    if not sport_id:
      return False

    bti_frames = [f for f in self._collect_all_frames() if self._is_bti_frame_url(f.url)]
    if not bti_frames and not any(
      self._is_bti_frame_url(f.url) for f in self._collect_all_frames()
    ):
      # iframe URL이 숨겨져 있어도 postMessage는 전체 iframe에 브로드캐스트
      logger.debug("[%s] BTI iframe URL 미확인 — postMessage 브로드캐스트", self.name)

    try:
      await self._page.evaluate(
        """
        (sportId) => {
          const payload = JSON.stringify({
            eventType: 'sportId',
            eventData: { value: String(sportId) },
          });
          for (const iframe of document.querySelectorAll('iframe')) {
            try {
              iframe.contentWindow?.postMessage(payload, '*');
            } catch (e) {}
          }
        }
        """,
        sport_id,
      )
      logger.info("[%s] BTI sportId=%s postMessage 전송 (%s)", self.name, sport_id, sport)
      await self._page.wait_for_timeout(3000)
      return True
    except Exception as e:
      logger.warning("[%s] BTI postMessage 실패: %s", self.name, e)
      return False

  async def _navigate_to_sport_tab(self, sport: str) -> bool:
    """BTI postMessage 또는 페이지 내 종목 탭 클릭."""
    if await self._navigate_bti_sport(sport):
      await self._wait_for_content_load()
      if await self._has_match_content():
        return True

    nav_texts = self._sport_nav_texts(sport)
    if not nav_texts:
      return True

    for text in nav_texts:
      if await self._click_by_text(text):
        logger.info("[%s] %s 종목 탭 클릭: %s", self.name, sport, text)
        await self._page.wait_for_timeout(2000)
        await self._wait_for_content_load()
        return True

    logger.warning("[%s] %s 종목 탭을 찾지 못했습니다", self.name, sport)
    return False

  def _build_url(self, event: str | None = None, sport: str | None = None) -> str:
    """필수 게임 URL 생성."""
    sport_key = sport or self._current_sport
    page_cfg = self._sport_page_config(sport_key)
    if page_cfg:
      return page_cfg["page_url"]

    if self.page_url and not event:
      return self.page_url
    params = {
      "gamecode": self.gamecode,
      "game_child_seq": self.game_child_seq,
      "event": event or self.event,
    }
    base = self.base_url.rstrip("/") if self.base_url else "https://pbc00.com"
    return f"{base}/game/newDetail/0?{urlencode(params)}"

  async def _goto_game_page(self, sport: str | None = None) -> None:
    """10벳 게임 URL로 접속 (이 URL 자체가 10벳 경기 목록)."""
    if sport:
      self._current_sport = sport
    game_url = self._build_url(sport=sport)
    logger.info("[%s] 10벳 URL 접속: %s", self.name, game_url)

    # networkidle 은 배팅 사이트에서 무한 대기 → domcontentloaded 사용
    try:
      await self._page.goto(game_url, wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
      logger.warning("[%s] 페이지 로드 지연 (계속 진행): %s", self.name, e)

    await self._page.wait_for_timeout(3000)
    logger.info("[%s] 현재 URL: %s", self.name, self._page.url)

    # 리다이렉트 시 1회만 재시도 (짧은 타임아웃)
    if "newDetail" not in self._page.url:
      logger.info("[%s] URL 변경됨 — 재접속 1회 시도", self.name)
      try:
        await self._page.goto(game_url, wait_until="load", timeout=20000)
        await self._page.wait_for_timeout(2000)
        logger.info("[%s] 재접속 후 URL: %s", self.name, self._page.url)
      except Exception as e:
        logger.warning("[%s] 재접속 타임아웃 (화면 상태로 진행): %s", self.name, e)

    logger.info("[%s] 페이지 로드 완료", self.name)
    await self._wait_for_iframes(max_wait=8)
    await self._wait_for_content_load()

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

      # ★ 반드시 게임 URL로 진입 (로그인도 이 페이지에서)
      first_sport = next(
        (s for s in SUPPORTED_SPORT_KEYS if self._sport_page_config(s)),
        "football",
      )
      await self._goto_game_page(sport=first_sport)

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

      # 로그인 후 게임 URL 유지 확인
      await self._goto_game_page()

      if not self.skip_tenbet_navigation:
        await self._navigate_to_tenbet()
      else:
        logger.info("[%s] 10벳 URL 직접 접속 — 추가 메뉴 클릭 없음", self.name)

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
    """XHR/Fetch JSON 응답 캡처 (BTI iframe API 포함)."""
    try:
      url = response.url
      url_l = url.lower()
      if not any(k in url_l for k in BTI_API_URL_HINTS):
        return
      ct = response.headers.get("content-type", "").lower()
      if "json" not in ct:
        return
      body = await response.json()
      self._captured_api_data.append({"url": url, "data": body})
      if any(h in url_l for h in ("bti", "sportsbook", "event", "market")):
        logger.debug("[%s] BTI/API: %s", self.name, url[:120])
      else:
        logger.debug("[%s] API: %s", self.name, url[:100])
    except Exception:
      pass

  async def _wait_for_iframes(self, max_wait: int = 8) -> None:
    """10벳 콘텐츠 iframe 로드 대기."""
    for i in range(max_wait):
      frames = [f for f in self._page.frames if f != self._page.main_frame]
      if frames:
        logger.info("[%s] iframe %d개 로드됨", self.name, len(frames))
        await self._page.wait_for_timeout(1500)
        return
      if i % 3 == 0:
        logger.debug("[%s] iframe 대기... (%d/%d)", self.name, i, max_wait)
      await self._page.wait_for_timeout(1000)
    logger.debug("[%s] iframe 없음 — 메인 페이지에서 진행", self.name)

  async def _wait_for_content_load(self) -> None:
    """경기 목록 로딩 대기 + 스크롤."""
    logger.info("[%s] 경기 목록 로딩 대기...", self.name)
    for attempt in range(3):
      if await self._has_match_content():
        logger.info("[%s] 경기 목록 확인됨", self.name)
        return
      logger.debug("[%s] 로딩 대기 %d/3", self.name, attempt + 1)
      await self._page.wait_for_timeout(2000)
      try:
        await self._page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
        await self._page.wait_for_timeout(1000)
      except Exception:
        pass
    logger.debug("[%s] 경기 목록 자동 감지 실패 — 스크래핑 시도", self.name)

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
    game_url = self._build_url()
    print()
    print("=" * 60)
    print("  [PBC00] 이 URL에서 로그인해 주세요:")
    print(f"  {game_url}")
    print()
    print("  1) 브라우저에서 아이디 / 비밀번호 입력")
    print("  2) 로그인 버튼 클릭")
    print("  3) 로그인 후 10벳 메뉴가 보이면 성공")
    print(f"  4) 최대 {self.login_wait_seconds}초 대기...")
    print("=" * 60)
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

    if await self._has_match_content():
      logger.info("[%s] 이미 경기/배당 화면입니다", self.name)
      return True

    await self._dump_clickable_elements()

    # 0) 설정된 navigation_clicks 순서대로 클릭
    for click_text in self.navigation_clicks:
      if await self._click_by_text(click_text):
        logger.info("[%s] navigation_clicks: '%s' 클릭", self.name, click_text)
        await page.wait_for_timeout(2000)

    # 1) CSS 셀렉터
    tenbet_sel = self.selectors.get("tenbet_entry", "")
    for sel in tenbet_sel.split(", "):
      sel = sel.strip()
      if not sel:
        continue
      try:
        for target in self._active_pages():
          loc = target.locator(sel)
          if await loc.count() > 0:
            await loc.first.click(timeout=5000)
            await page.wait_for_timeout(3000)
            logger.info("[%s] 10벳 진입 (셀렉터: %s)", self.name, sel)
            await self._wait_for_match_content()
            return True
      except Exception as e:
        logger.debug("[%s] 셀렉터 실패 %s: %s", self.name, sel, e)

    # 2) 텍스트/역할 기반 클릭
    for text in self.navigation_texts:
      if await self._click_by_text(text):
        logger.info("[%s] 10벳 진입 (텍스트: %s)", self.name, text)
        await self._wait_for_match_content()
        return True

    # 3) 이미지 alt / title 속성
    if await self._click_by_alt_or_title():
      await self._wait_for_match_content()
      return True

    # 4) JS로 10벳 관련 요소 탐색 클릭
    if await self._click_tenbet_via_js():
      await self._wait_for_match_content()
      return True

    # 5) 수동 클릭 대기
    if self.manual_tenbet:
      return await self._manual_tenbet_wait()

    logger.warning(
      "[%s] 10벳 메뉴를 찾지 못했습니다. "
      "python -m src.main pbc00-setup 실행 후 "
      "config/pbc00_elements.json 을 확인하세요.",
      self.name,
    )
    await self._save_debug_screenshot("tenbet_not_found")
    return False

  async def _click_by_alt_or_title(self) -> bool:
    """img alt, title 속성으로 10벳 버튼 클릭."""
    patterns = ["10벳", "10BET", "10bet", "10 bet", "tenbet"]
    for target in self._active_pages():
      for pat in patterns:
        for attr in ["alt", "title", "aria-label"]:
          try:
            loc = target.locator(f"[{attr}*='{pat}' i]")
            if await loc.count() > 0:
              await loc.first.click(timeout=5000)
              await self._page.wait_for_timeout(2000)
              logger.info("[%s] 10벳 진입 (%s=%s)", self.name, attr, pat)
              return True
          except Exception:
            pass
    return False

  async def _click_tenbet_via_js(self) -> bool:
    """JavaScript로 10벳 관련 클릭 가능 요소 탐색."""
    script = """
    () => {
      const keywords = ['10벳','10BET','10bet','10 벳','텐벳','tenbet','10 bet'];
      const els = document.querySelectorAll('a, button, [onclick], [role="button"], img, div, span');
      for (const el of els) {
        const text = (el.innerText || el.alt || el.title || el.getAttribute('aria-label') || '').trim();
        if (keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))) {
          el.click();
          return text;
        }
      }
      return null;
    }
    """
    for target in self._active_pages():
      try:
        result = await target.evaluate(script)
        if result:
          logger.info("[%s] 10벳 JS 클릭: %s", self.name, result)
          await self._page.wait_for_timeout(3000)
          return True
      except Exception:
        pass
    return False

  async def _manual_tenbet_wait(self) -> bool:
    """사용자가 브라우저에서 10벳을 직접 클릭할 때까지 대기."""
    print()
    print("=" * 60)
    print("  [PBC00] 브라우저에서 10벳 메뉴를 직접 클릭해 주세요!")
    print("  1) 게임 URL 페이지에서 10벳(10BET) 버튼/메뉴 클릭")
    print("  2) 경기 목록이 보이면")
    print("  3) 이 창으로 돌아와서 Enter 키 누르기")
    print(f"  (최대 {self.tenbet_wait_seconds}초 대기)")
    print("=" * 60)
    print()

    loop = asyncio.get_event_loop()
    try:
      await asyncio.wait_for(
        loop.run_in_executor(None, input, "  ▶ 10벳 클릭 완료 후 Enter... "),
        timeout=self.tenbet_wait_seconds,
      )
    except asyncio.TimeoutError:
      logger.error("[%s] 10벳 수동 클릭 시간 초과", self.name)
      return False

    await self._save_session()
    await self._save_debug_screenshot("after_tenbet_manual")
    await self._dump_clickable_elements()
    logger.info("[%s] 수동 10벳 진입 완료", self.name)
    return True

  async def _dump_clickable_elements(self) -> dict:
    """페이지의 클릭 가능한 요소 목록 저장 (디버그용)."""
    if not self._page:
      return {}

    elements: list[dict] = []
    for target in self._active_pages():
      frame_url = target.url if hasattr(target, "url") else "main"
      try:
        items = await target.evaluate("""
          () => {
            const results = [];
            const els = document.querySelectorAll('a, button, [onclick], [role="button"], img');
            for (const el of els) {
              const text = (el.innerText || '').trim().slice(0, 80);
              const alt = el.alt || '';
              const title = el.title || '';
              const cls = el.className || '';
              const id = el.id || '';
              if (text || alt || title) {
                results.push({tag: el.tagName, text, alt, title, id,
                  cls: typeof cls === 'string' ? cls.slice(0, 60) : ''});
              }
            }
            return results.slice(0, 200);
          }
        """)
        for item in items:
          item["frame"] = frame_url[:80]
          elements.append(item)
      except Exception:
        pass

    output = {
      "url": self._page.url,
      "frames": [f.url for f in self._page.frames],
      "elements": elements,
      "tenbet_candidates": [
        e for e in elements
        if re.search(r"10|벳|bet|sport", f"{e.get('text','')}{e.get('alt','')}{e.get('title','')}", re.I)
      ],
    }

    path = Path("config/pbc00_elements.json")
    path.parent.mkdir(exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
      json.dump(output, f, ensure_ascii=False, indent=2)
    logger.info("[%s] 페이지 요소 저장: %s (%d개)", self.name, path, len(elements))
    return output

  async def _click_by_text(self, text: str) -> bool:
    """페이지 및 iframe에서 텍스트 클릭."""
    page = self._page
    targets = self._active_pages()

    for target in targets:
      # 부분 일치 텍스트
      for exact in [False, True]:
        try:
          loc = target.get_by_text(text, exact=exact)
          count = await loc.count()
          for i in range(min(count, 3)):
            try:
              await loc.nth(i).click(timeout=5000)
              await page.wait_for_timeout(2000)
              return True
            except Exception:
              pass
        except Exception:
          pass

      for role in ["link", "button", "tab", "menuitem"]:
        try:
          loc = target.get_by_role(role, name=re.compile(re.escape(text), re.I))
          if await loc.count() > 0:
            await loc.first.click(timeout=5000)
            await page.wait_for_timeout(2000)
            return True
        except Exception:
          pass

    return False

  async def _has_match_content(self) -> bool:
    """경기 목록/배당이 이미 로드됐는지 확인."""
    checks = [
      self.selectors.get("match_row", "").split(", ")[0],
      ".odds", "[class*='odds']", "[class*='match']",
      "table tbody tr", ".game-list",
    ]
    for target in self._active_pages():
      for sel in checks:
        sel = (sel or "").strip()
        if not sel:
          continue
        try:
          if await target.locator(sel).count() >= 2:
            return True
        except Exception:
          pass
    if len(self._captured_api_data) > 0:
      return bool(self._parse_api_data())
    return False

  async def _wait_for_match_content(self, timeout_ms: int = 15000) -> None:
    """경기 목록 또는 배당 요소가 로드될 때까지 대기."""
    wait_selectors = [
      self.selectors.get("match_row", "").split(", ")[0],
      ".odds", "[class*='odds']", "[class*='Odds']",
      "[class*='match']", "[class*='event']", "[class*='Event']",
      "table", ".game-list", ".event",
    ]
    per_frame_timeout = max(3000, timeout_ms // max(len(self._active_pages()), 1))

    for target in self._active_pages():
      for sel in wait_selectors:
        sel = (sel or "").strip()
        if not sel:
          continue
        try:
          await target.wait_for_selector(sel, timeout=per_frame_timeout)
          logger.debug("[%s] 콘텐츠 로드 확인: %s (frame)", self.name, sel)
          return
        except Exception:
          pass

    await self._page.wait_for_timeout(3000)

  def _active_pages(self) -> list:
    """스크래핑 대상 페이지 목록 (메인 + 중첩 iframe)."""
    if not self._page:
      return []
    frames = self._collect_all_frames()
    # Frame 객체와 Page 모두 locator API 호환
    return [self._page, *[f for f in frames if f != self._page.main_frame]]

  async def disconnect(self) -> None:
    if self._browser:
      await self._browser.close()
    if self._playwright:
      await self._playwright.stop()
    self._logged_in = False

  async def fetch_odds(self, sports: list[str] | None = None) -> list[MatchOdds]:
    if not self._page:
      return []

    target_sports = sports or SUPPORTED_SPORT_KEYS
    all_results: list[MatchOdds] = []

    # 동일 URL은 한 번만 로드하고 종목 탭만 전환
    url_groups: dict[str, list[str]] = {}
    for sport in target_sports:
      page_cfg = self._sport_page_config(sport)
      if not page_cfg:
        sport_def = get_sport(sport)
        if sport_def and not sport_def.pbc00_page_url(self.base_url or "https://pbc00.com"):
          logger.debug("[%s] %s: pbc00 URL 미설정 — 건너뜀", self.name, sport)
        else:
          logger.warning(
            "[%s] %s: sport_pages에 gamecode/page_url을 설정하세요",
            self.name, sport,
          )
        continue
      url_groups.setdefault(page_cfg["page_url"], []).append(sport)

    for sport_list in url_groups.values():
      for i, sport in enumerate(sport_list):
        sport_odds = await self._fetch_odds_for_sport(
          sport, reload_page=(i == 0),
        )
        all_results.extend(sport_odds)
        logger.info("[%s] %s: %d개 마켓", self.name, sport, len(sport_odds))

    if not all_results:
      logger.warning("[%s] 배당 데이터를 찾지 못했습니다", self.name)

    return all_results

  async def _fetch_odds_for_sport(
    self, sport: str, reload_page: bool = True,
  ) -> list[MatchOdds]:
    """단일 종목 페이지에서 배당 수집."""
    self._current_sport = sport
    self._captured_api_data.clear()

    if reload_page:
      await self._goto_game_page(sport=sport)

      if not await self._is_logged_in():
        await self._ensure_logged_in()
        await self._goto_game_page(sport=sport)

      if not self.skip_tenbet_navigation:
        await self._navigate_to_tenbet()

    await self._navigate_to_sport_tab(sport)

    await self._wait_for_content_load()
    await self._page.wait_for_timeout(2000)

    try:
      Path("config").mkdir(exist_ok=True)
      await self._page.screenshot(
        path=f"config/pbc00_debug_{sport}.png", full_page=True,
      )
      logger.debug("[%s] 스크린샷: config/pbc00_debug_%s.png", self.name, sport)
    except Exception:
      pass

    api_results = self._parse_api_data()
    if api_results:
      logger.info("[%s] %s API %d개 마켓", self.name, sport, len(api_results))
      return api_results

    dom_results = await self._scrape_dom()
    if dom_results:
      logger.info("[%s] %s DOM %d개 마켓", self.name, sport, len(dom_results))
      return dom_results

    generic = await self._scrape_dom_generic()
    if generic:
      logger.info("[%s] %s 텍스트 %d개 마켓", self.name, sport, len(generic))
      return generic

    await self._save_debug_screenshot(f"no_odds_{sport}")
    await self._dump_clickable_elements()
    await self._save_bti_api_samples(sport)
    api_urls = [c["url"] for c in self._captured_api_data]
    path = Path(f"config/pbc00_api_urls_{sport}.json")
    path.parent.mkdir(exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
      json.dump(api_urls, f, ensure_ascii=False, indent=2)
    logger.info("[%s] %s API URL %d개 저장: %s", self.name, sport, len(api_urls), path)
    return []

  async def _save_bti_api_samples(self, sport: str) -> None:
    """BTI/API 응답 샘플 저장 (디버그)."""
    if not self._captured_api_data:
      return
    path = Path(f"config/pbc00_bti_samples_{sport}.json")
    path.parent.mkdir(exist_ok=True)
    samples = []
    for c in self._captured_api_data[:30]:
      body = c["data"]
      samples.append({
        "url": c["url"],
        "preview": json.dumps(body, ensure_ascii=False)[:2000],
      })
    with open(path, "w", encoding="utf-8") as f:
      json.dump(samples, f, ensure_ascii=False, indent=2)
    logger.info("[%s] API 샘플 저장: %s (%d건)", self.name, path, len(samples))

  def _parse_api_data(self) -> list[MatchOdds]:
    """캡처된 API 응답에서 배당 파싱 (범용 + BTI)."""
    results: list[MatchOdds] = []
    seen: set[str] = set()

    for captured in self._captured_api_data:
      data = captured["data"]
      bti_results = self._parse_bti_payload(data)
      for mo in bti_results:
        key = match_key(mo.match.home_team, mo.match.away_team, mo.match.sport)
        if key not in seen:
          seen.add(key)
          results.append(mo)

      items = self._find_match_lists(data)
      for item in items:
        parsed = self._parse_match_item(item)
        if parsed:
          key = match_key(parsed.match.home_team, parsed.match.away_team, parsed.match.sport)
          if key not in seen:
            seen.add(key)
            results.append(parsed)

    return results

  def _parse_bti_payload(self, data: Any) -> list[MatchOdds]:
    """BTI 스포츠북 JSON 구조 파싱."""
    results: list[MatchOdds] = []
    events = self._find_bti_events(data)
    for event in events:
      parsed = self._parse_bti_event(event)
      if parsed:
        results.append(parsed)
    return results

  def _find_bti_events(self, data: Any, depth: int = 0) -> list[dict]:
    if depth > 8:
      return []

    if isinstance(data, dict):
      if self._looks_like_bti_event(data):
        return [data]
      found: list[dict] = []
      for value in data.values():
        found.extend(self._find_bti_events(value, depth + 1))
      return found

    if isinstance(data, list):
      if data and isinstance(data[0], dict) and self._looks_like_bti_event(data[0]):
        return [x for x in data if isinstance(x, dict)]
      found = []
      for item in data:
        found.extend(self._find_bti_events(item, depth + 1))
      return found

    return []

  def _looks_like_bti_event(self, item: dict) -> bool:
    if not isinstance(item, dict):
      return False
    keys = {k.lower() for k in item.keys()}
    has_teams = bool(
      keys & {"hometeam", "awayteam", "participants", "competitors", "teams"}
      or item.get("eventName") or item.get("eventname")
    )
    has_markets = bool(
      keys & {"markets", "market", "selections", "lines", "odds"}
      or isinstance(item.get("markets"), list)
    )
    return has_teams and has_markets

  def _parse_bti_event(self, event: dict) -> MatchOdds | None:
    home, away = self._extract_bti_teams(event)
    if not home or not away:
      name = str(event.get("eventName") or event.get("name") or "")
      for sep in (" vs ", " VS ", " v ", " @ "):
        if sep in name:
          parts = name.split(sep, 1)
          home, away = parts[0].strip(), parts[1].strip()
          break
    if not home or not away:
      return None

    home_odds, away_odds, draw_odds = self._extract_bti_moneyline(event)
    if not home_odds or not away_odds:
      return None

    match_id = str(event.get("id") or event.get("eventId") or f"bti_{home}_{away}")
    match = Match(
      match_id=f"pbc00_{match_id}",
      sport=self._current_sport,
      home_team=home,
      away_team=away,
      league=str(event.get("leagueName") or event.get("league") or ""),
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

  def _extract_bti_teams(self, event: dict) -> tuple[str | None, str | None]:
    home = away = None

    for key in ("homeTeam", "HomeTeam", "home_team", "homeTeamName"):
      if event.get(key):
        home = str(event[key])
        break
    for key in ("awayTeam", "AwayTeam", "away_team", "awayTeamName"):
      if event.get(key):
        away = str(event[key])
        break
    if home and away:
      return home, away

    participants = event.get("participants") or event.get("competitors") or event.get("teams") or []
    if isinstance(participants, list):
      for p in participants:
        if not isinstance(p, dict):
          continue
        name = p.get("name") or p.get("teamName") or p.get("participantName")
        if not name:
          continue
        role = str(
          p.get("venueRole") or p.get("alignment") or p.get("side") or p.get("position") or ""
        ).lower()
        if role in ("home", "h", "1"):
          home = str(name)
        elif role in ("away", "a", "2"):
          away = str(name)
      if not home and len(participants) >= 2:
        home = str(participants[0].get("name", participants[0]) if isinstance(participants[0], dict) else participants[0])
        away = str(participants[1].get("name", participants[1]) if isinstance(participants[1], dict) else participants[1])

    return home, away

  def _extract_bti_moneyline(self, event: dict) -> tuple[float | None, float | None, float | None]:
    markets = event.get("markets") or event.get("market") or []
    if isinstance(markets, dict):
      markets = [markets]
    if not isinstance(markets, list):
      return None, None, None

    home_odds = away_odds = draw_odds = None

    for market in markets:
      if not isinstance(market, dict):
        continue
      mtype = str(market.get("marketType") or market.get("type") or market.get("name") or "").upper()
      if mtype and mtype not in ("ML", "MONEYLINE", "1X2", "WIN", "MATCH", "MATCH_ODDS", ""):
        if "TOTAL" in mtype or "HANDICAP" in mtype or "SPREAD" in mtype:
          continue

      selections = (
        market.get("selections") or market.get("outcomes")
        or market.get("runners") or market.get("prices") or []
      )
      if isinstance(selections, dict):
        selections = list(selections.values())

      for sel in selections:
        if not isinstance(sel, dict):
          continue
        price = self._read_price(sel)
        if not price:
          continue
        label = str(
          sel.get("name") or sel.get("designation") or sel.get("side") or sel.get("type") or ""
        ).lower()
        if label in ("home", "h", "1", "team1") or "home" in label:
          home_odds = price
        elif label in ("away", "a", "2", "team2") or "away" in label:
          away_odds = price
        elif label in ("draw", "x", "tie"):
          draw_odds = price

      if home_odds and away_odds:
        return home_odds, away_odds, draw_odds

    # selections가 market 없이 event 루트에 있는 경우
    root_selections = event.get("selections") or []
    if isinstance(root_selections, list):
      for sel in root_selections:
        if not isinstance(sel, dict):
          continue
        price = self._read_price(sel)
        if not price:
          continue
        label = str(sel.get("name") or sel.get("side") or "").lower()
        if "home" in label or label == "h":
          home_odds = price
        elif "away" in label or label == "a":
          away_odds = price
        elif "draw" in label or label == "x":
          draw_odds = price

    return home_odds, away_odds, draw_odds

  def _read_price(self, sel: dict) -> float | None:
    for key in (
      "price", "odds", "decimal", "decimalOdds", "displayOdds",
      "currentPrice", "value", "odd",
    ):
      val = sel.get(key)
      if val is not None:
        try:
          return self._to_decimal(float(val))
        except (TypeError, ValueError):
          pass
    return None

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
        "hTeam", "aTeam", "team_h", "team_a", "competitor",
        "HomeTeam", "AwayTeam", "eventName", "participants",
        "competitors", "markets", "selections",
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
      sport=self._current_sport,
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
            sport=self._current_sport,
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

  async def _scrape_dom_generic(self) -> list[MatchOdds]:
    """페이지 전체 텍스트에서 '팀 vs 팀' + 배당 패턴 탐색."""
    results: list[MatchOdds] = []
    vs_pattern = re.compile(
      r"([^\n]{2,40}?)\s+(?:vs|VS|v\.s\.|대)\s+([^\n]{2,40})",
      re.MULTILINE,
    )
    odds_pattern = re.compile(r"\b([1-9]\d*\.\d{2})\b")

    for target in self._active_pages():
      try:
        text = await target.inner_text("body")
      except Exception:
        continue

      for i, m in enumerate(vs_pattern.finditer(text)):
        home = m.group(1).strip()
        away = m.group(2).strip()
        if len(home) < 2 or len(away) < 2:
          continue

        # vs 매치 이후 200자 안에서 배당 2개 찾기
        snippet = text[m.end(): m.end() + 200]
        odds_vals = [float(x) for x in odds_pattern.findall(snippet) if 1.01 <= float(x) <= 50.0]
        if len(odds_vals) < 2:
          continue

        match = Match(
          match_id=f"pbc00_txt_{i}",
          sport=self._current_sport,
          home_team=home,
          away_team=away.split()[0] if len(away) > 30 else away,
        )
        results.append(MatchOdds(
          match=match,
          site=self.name,
          market_type=MarketType.MONEYLINE,
          odds=[
            Odds(outcome=Outcome.HOME, value=odds_vals[0], site=self.name),
            Odds(outcome=Outcome.AWAY, value=odds_vals[1], site=self.name),
          ],
        ))

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
