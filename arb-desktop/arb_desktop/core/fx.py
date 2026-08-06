from __future__ import annotations

import time
from typing import Any

import httpx

from arb_desktop.config import settings


class FxRateProvider:
  """Bithumb USDT/KRW — 60s cache."""

  def __init__(self) -> None:
      self._rate: float = settings.default_usdt_rate
      self._fetched_at: float = 0.0
      self._ttl_sec: float = 60.0

  @property
  def rate(self) -> float:
      return self._rate

  async def refresh(self, client: httpx.AsyncClient | None = None) -> float:
      now = time.time()
      if now - self._fetched_at < self._ttl_sec:
          return self._rate
      own = client is None
      if own:
          client = httpx.AsyncClient(timeout=5.0)
      try:
          resp = await client.get("https://api.bithumb.com/public/ticker/USDT_KRW")
          resp.raise_for_status()
          data = resp.json()
          price = float(data.get("data", {}).get("closing_price", 0))
          if price > 0:
              self._rate = price
              self._fetched_at = now
      except Exception:
          pass
      finally:
          if own:
              await client.aclose()
      return self._rate

  def krw_to_usd(self, krw: float) -> float | None:
      if not krw or not self._rate:
          return None
      return round(krw / self._rate, 2)

  def usd_to_krw(self, usd: float) -> float | None:
      if not usd or not self._rate:
          return None
      return round(usd * self._rate)


fx_provider = FxRateProvider()
