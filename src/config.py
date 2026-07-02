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
    return AppConfig(**data)

  return AppConfig()


def setup_logging(level: str = "INFO") -> None:
  logging.basicConfig(
    level=getattr(logging, level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
  )
