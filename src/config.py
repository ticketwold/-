from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings


class SiteConfig(BaseModel):
  name: str
  enabled: bool = True
  base_url: str = ""
  username: str = ""
  password: str = ""
  adapter: str = "mock"


class AppConfig(BaseSettings):
  poll_interval: float = 2.0
  min_profit_margin: float = 0.5
  total_stake: float = 100_000
  max_concurrent_bets: int = 3
  dry_run: bool = True
  log_level: str = "INFO"
  site_a: SiteConfig = Field(default_factory=lambda: SiteConfig(name="SiteA"))
  site_b: SiteConfig = Field(default_factory=lambda: SiteConfig(name="SiteB"))
  sports: list[str] = Field(default_factory=lambda: ["football", "basketball"])
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
