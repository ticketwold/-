from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import BaseSettings


class SportPageConfig(BaseModel):
  """pbc00 등 종목별 게임 페이지 설정."""

  model_config = ConfigDict(extra="allow")

  enabled: bool = True
  gamecode: str = ""
  game_child_seq: str = ""
  event: str = "N"
  page_url: str = ""
  nav_text: str = ""
  nav_texts: list[str] = Field(default_factory=list)
  bti_sport_id: str = ""


class SiteConfig(BaseModel):
  model_config = ConfigDict(extra="allow")

  name: str
  enabled: bool = True
  base_url: str = ""
  username: str = ""
  password: str = ""
  adapter: str = "mock"
  # Pinnacle 전용
  skip_live: bool = True
  league_filter: list[str] = Field(default_factory=list)
  # PBC00 전용
  gamecode: str = "19"
  game_child_seq: str = "3659"
  event: str = "N"
  page_url: str = ""  # 전체 URL 직접 지정 시 우선 사용
  cookies_path: str = ""
  navigation_texts: list[str] = Field(
    default_factory=lambda: ["10벳", "10BET", "10bet", "10 벳", "텐벳"]
  )
  headless: bool = False
  manual_login: bool = True
  manual_tenbet: bool = False
  skip_tenbet_navigation: bool = True
  login_url: str = ""
  login_wait_seconds: int = 120
  tenbet_wait_seconds: int = 120
  navigation_clicks: list[str] = Field(default_factory=list)
  selectors: dict[str, str] = Field(default_factory=dict)
  # 종목별 pbc00 URL (football, baseball, basketball, esports, tennis)
  sport_pages: dict[str, SportPageConfig] = Field(default_factory=dict)


class AppConfig(BaseSettings):
  poll_interval: float = 2.0
  min_profit_margin: float = 0.5
  total_stake: float = 100_000
  max_concurrent_bets: int = 3
  dry_run: bool = True
  log_level: str = "INFO"
  site_a: SiteConfig = Field(default_factory=lambda: SiteConfig(name="SiteA"))
  site_b: SiteConfig = Field(default_factory=lambda: SiteConfig(name="SiteB"))
  sports: list[str] = Field(
    default_factory=lambda: ["football", "baseball", "basketball", "esports", "tennis"]
  )
  markets: list[str] = Field(default_factory=lambda: ["moneyline", "over_under"])


_DEFAULT_SITE_A: dict = {
  "name": "Pinnacle",
  "adapter": "pinnacle",
  "base_url": "https://www.pinnacle.com/ko/",
  "skip_live": True,
}

_DEFAULT_SITE_B: dict = {
  "name": "PBC00",
  "adapter": "pbc00",
  "base_url": "https://pbc00.com",
  "page_url": (
    "https://pbc00.com/game/newDetail/0"
    "?gamecode=19&game_child_seq=3659&event=N"
  ),
  "gamecode": "19",
  "game_child_seq": "3659",
  "event": "N",
  "cookies_path": "config/pbc00_session.json",
  "manual_login": True,
  "skip_tenbet_navigation": True,
  "headless": False,
}


def _merge_dict(base: dict, override: dict | None) -> dict:
  """중첩 dict 병합 (sport_pages 등)."""
  if not override:
    return dict(base)
  merged = dict(base)
  for key, value in override.items():
    if (
      key in merged
      and isinstance(merged[key], dict)
      and isinstance(value, dict)
    ):
      merged[key] = _merge_dict(merged[key], value)
    else:
      merged[key] = value
  return merged


def _normalize_config_data(data: dict) -> dict:
  """부분 YAML도 기본 site 설정과 병합."""
  normalized = dict(data)
  normalized["site_a"] = _merge_dict(
    _DEFAULT_SITE_A,
    normalized.get("site_a") if isinstance(normalized.get("site_a"), dict) else None,
  )
  normalized["site_b"] = _merge_dict(
    _DEFAULT_SITE_B,
    normalized.get("site_b") if isinstance(normalized.get("site_b"), dict) else None,
  )
  return normalized


def load_config(path: Optional[str] = None) -> AppConfig:
  """YAML 설정 파일 로드."""
  if path is None:
    candidates = [
      Path("config/settings.yaml"),
      Path("config/settings.yaml.example"),
    ]
    for c in candidates:
      if c.exists():
        path = str(c)
        break

  if path and Path(path).exists():
    with open(path, encoding="utf-8") as f:
      data = yaml.safe_load(f) or {}
    return AppConfig(**_normalize_config_data(data))

  return AppConfig()


def setup_logging(level: str = "INFO") -> None:
  logging.basicConfig(
    level=getattr(logging, level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
  )
