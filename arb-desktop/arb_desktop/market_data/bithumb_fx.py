from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from enum import Enum
from typing import Any

import httpx

logger = logging.getLogger(__name__)

BITHUMB_TICKER_URL = "https://api.bithumb.com/v1/ticker?markets=KRW-USDT"
MIN_RATE = 500.0
MAX_RATE = 5000.0


class FxStatus(str, Enum):
    LOADING = "fx-loading"
    LIVE = "fx-live"
    DELAYED = "fx-delayed"
    STALE = "fx-rate-stale"
    ERROR = "fx-api-error"


@dataclass(frozen=True)
class FxSnapshot:
    rate: float | None
    status: FxStatus
    source: str = "빗썸 KRW-USDT"
    updated_at: float | None = None
    age_seconds: float = 0.0
    message: str = ""

    def is_usable(self, max_stale_seconds: float) -> bool:
        if self.rate is None or self.updated_at is None:
            return False
        return self.age_seconds <= max_stale_seconds


def _extract_trade_price(payload: Any) -> float | None:
    rows: list[dict[str, Any]] = []
    if isinstance(payload, list):
        rows = [row for row in payload if isinstance(row, dict)]
    elif isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            rows = [row for row in data if isinstance(row, dict)]
        elif isinstance(data, dict):
            rows = [data]
        elif "trade_price" in payload:
            rows = [payload]

    for row in rows:
        market = str(row.get("market") or row.get("Market") or "")
        if market and market.upper() != "KRW-USDT":
            continue
        price = row.get("trade_price", row.get("closing_price"))
        if price is None:
            continue
        try:
            val = float(price)
        except (TypeError, ValueError):
            continue
        if MIN_RATE <= val <= MAX_RATE:
            return val
    return None


class BithumbFxProvider:
    """빗썸 KRW-USDT 실시간 환율 — asyncio 기반."""

    def __init__(
        self,
        *,
        refresh_interval: float = 2.0,
        timeout: float = 3.0,
        delayed_after: float = 5.0,
        max_stale_seconds: float = 30.0,
    ) -> None:
        self._refresh_interval = refresh_interval
        self._timeout = timeout
        self._delayed_after = delayed_after
        self._max_stale_seconds = max_stale_seconds
        self._last_rate: float | None = None
        self._last_ok_at: float | None = None
        self._last_attempt_at: float | None = None
        self._last_error: str = ""

    @property
    def max_stale_seconds(self) -> float:
        return self._max_stale_seconds

    def snapshot(self) -> FxSnapshot:
        now = time.time()
        if self._last_ok_at is None:
            if self._last_attempt_at is None:
                return FxSnapshot(rate=None, status=FxStatus.LOADING, message="환율 조회 중")
            return FxSnapshot(
                rate=None,
                status=FxStatus.ERROR,
                updated_at=self._last_attempt_at,
                age_seconds=now - self._last_attempt_at,
                message=self._last_error or "환율 조회 실패",
            )

        age = now - self._last_ok_at
        if age > self._max_stale_seconds:
            status = FxStatus.STALE
            message = "환율 갱신 지연 — 계산 중단"
        elif age > self._delayed_after:
            status = FxStatus.DELAYED
            message = "환율 갱신 지연"
        else:
            status = FxStatus.LIVE
            message = "LIVE"

        return FxSnapshot(
            rate=self._last_rate,
            status=status,
            updated_at=self._last_ok_at,
            age_seconds=age,
            message=message,
        )

    async def refresh(self, client: httpx.AsyncClient | None = None) -> FxSnapshot:
        self._last_attempt_at = time.time()
        own = client is None
        if own:
            client = httpx.AsyncClient(timeout=self._timeout)
        try:
            resp = await client.get(BITHUMB_TICKER_URL)
            resp.raise_for_status()
            price = _extract_trade_price(resp.json())
            if price is None:
                self._last_error = "trade_price 필드 없음"
                logger.warning("bithumb fx: trade_price missing in response")
                return self.snapshot()
            self._last_rate = price
            self._last_ok_at = time.time()
            self._last_error = ""
            return self.snapshot()
        except Exception as exc:
            self._last_error = str(exc)
            logger.warning("bithumb fx refresh failed: %s", exc)
            return self.snapshot()
        finally:
            if own:
                await client.aclose()

    async def run_loop(self, on_update) -> None:
        while True:
            snap = await self.refresh()
            on_update(snap)
            await asyncio.sleep(self._refresh_interval)
