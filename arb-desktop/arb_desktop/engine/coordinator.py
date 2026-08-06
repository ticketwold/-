from __future__ import annotations

import asyncio
from time import perf_counter, perf_counter_ns
from typing import Callable

from arb_desktop.config import settings
from arb_desktop.core.fx import fx_provider
from arb_desktop.core.odds_engine import OddsEngine
from arb_desktop.models import EngineTick
from arb_desktop.scanners.playwright.session import BrowserSession
from arb_desktop.scanners.sites.bc_game import BcGameScanner
from arb_desktop.scanners.sites.bti_x10 import BtiX10Scanner


class Coordinator:
    """메인 스캔 루프 — 목표: 감지+계산 50ms 이하."""

    def __init__(self, on_tick: Callable[[EngineTick], None] | None = None):
        self._on_tick = on_tick
        self._running = False
        self._task: asyncio.Task | None = None
        self._session = BrowserSession()
        self._bti = BtiX10Scanner(self._session)
        self._bc = BcGameScanner(self._session)
        self._engine = OddsEngine(
            min_profit_pct=settings.min_profit_pct,
            bti_stake_krw=settings.default_bti_stake_krw,
            usdt_rate=settings.default_usdt_rate,
        )

    @property
    def engine(self) -> OddsEngine:
        return self._engine

    async def start(self) -> None:
        await self._session.start()
        await self._bti.start()
        await self._bc.start()

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._session.stop()

    def start_loop(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())

    def stop_loop(self) -> None:
        self._running = False

    async def tick_once(self) -> EngineTick:
        tick_start = perf_counter()
        await fx_provider.refresh()
        self._engine.usdt_rate = fx_provider.rate

        bti_snap, bc_snap = await asyncio.gather(self._bti.scan(), self._bc.scan())
        detection_ms = max(bti_snap.latency_ms, bc_snap.latency_ms)
        calc_start = perf_counter_ns()

        opps = self._engine.find_opportunities(
            bti_snap.matchups,
            bc_snap.matchups,
            detection_ms=detection_ms,
            calc_started_ns=calc_start,
        )
        calc_ms = (perf_counter_ns() - calc_start) / 1_000_000
        tick_ms = (perf_counter() - tick_start) * 1000

        result = EngineTick(
            bti=bti_snap,
            bc=bc_snap,
            opportunities=opps,
            tick_latency_ms=tick_ms,
            calc_latency_ms=calc_ms,
        )
        if self._on_tick:
            self._on_tick(result)
        return result

    async def _loop(self) -> None:
        interval = settings.scan_interval_ms / 1000
        while self._running:
            try:
                await self.tick_once()
            except Exception:
                pass
            await asyncio.sleep(interval)
