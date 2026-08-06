from __future__ import annotations

import asyncio
from time import perf_counter, perf_counter_ns
from typing import Callable

from arb_desktop.betslip.models import BetSlipScanResult
from arb_desktop.betslip.scanner import BetSlipScanner
from arb_desktop.config import settings
from arb_desktop.core.fx import fx_provider
from arb_desktop.core.odds_engine import OddsEngine
from arb_desktop.models import ArbOpportunity, DetectionTier, EngineTick, ScanSnapshot, SiteId
from arb_desktop.scanners.playwright.session import BrowserSession
from arb_desktop.scanners.sites.bc_game import BcGameScanner
from arb_desktop.scanners.sites.bti_x10 import BtiX10Scanner


class Coordinator:
    """메인 루프 — BetSlip-first 모드(기본) 또는 레거시 전체 경기 스캔."""

    def __init__(self, on_tick: Callable[[EngineTick], None] | None = None):
        self._on_tick = on_tick
        self._running = False
        self._task: asyncio.Task | None = None
        self._session = BrowserSession()
        self._betslip = BetSlipScanner(self._session)
        self._bti: BtiX10Scanner | None = None
        self._bc: BcGameScanner | None = None
        if not settings.betslip_first_mode:
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
        if self._bti and self._bc:
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

    def _betslip_to_opportunities(self, scan: BetSlipScanResult) -> list[ArbOpportunity]:
        if not scan.arbitrage or not scan.match.safe_to_calculate:
            return []
        arb = scan.arbitrage
        bc = scan.bc.first
        bti = scan.bti.first
        if not bc or not bti or arb.profit_rate is None:
            return []
        if arb.profit_rate < self._engine.min_profit_pct:
            return []

        home, away = bc.event.split(" vs ", 1) if " vs " in bc.event else (bc.event, "")
        return [
            ArbOpportunity(
                home=home,
                away=away,
                league="",
                bti_side=bti.selection,
                bti_odds=bti.odds or 0.0,
                bc_team=bc.selection,
                bc_odds=bc.odds or 0.0,
                profit_pct=arb.profit_rate,
                bti_stake_krw=arb.stake_b or settings.default_bti_stake_krw,
                bc_stake_usdt=arb.stake_a or 0.0,
                usdt_rate=settings.default_usdt_rate,
                detection_ms=0.0,
                calc_ms=0.0,
            )
        ]

    async def tick_once(self) -> EngineTick:
        tick_start = perf_counter()
        if settings.betslip_first_mode:
            return await self._tick_betslip(tick_start)
        return await self._tick_full_board(tick_start)

    async def _tick_betslip(self, tick_start: float) -> EngineTick:
        calc_start = perf_counter_ns()
        scan = await self._betslip.scan()
        opps = self._betslip_to_opportunities(scan)
        calc_ms = (perf_counter_ns() - calc_start) / 1_000_000
        tick_ms = (perf_counter() - tick_start) * 1000

        bti_snap = ScanSnapshot(
            site=SiteId.BTI_X10,
            matchups=[],
            tier=DetectionTier.PLAYWRIGHT_DOM,
            latency_ms=tick_ms,
            ok=not scan.bti.empty,
            message=f"BetSlip {scan.bti.first.selection if scan.bti.first else 'empty'}",
        )
        bc_snap = ScanSnapshot(
            site=SiteId.BC_GAME,
            matchups=[],
            tier=DetectionTier.PLAYWRIGHT_DOM,
            latency_ms=tick_ms,
            ok=not scan.bc.empty,
            message=f"BetSlip {scan.bc.first.selection if scan.bc.first else 'empty'}",
        )

        result = EngineTick(
            bti=bti_snap,
            bc=bc_snap,
            opportunities=opps,
            tick_latency_ms=tick_ms,
            calc_latency_ms=calc_ms,
            betslip=scan,
        )
        if self._on_tick:
            self._on_tick(result)
        return result

    async def _tick_full_board(self, tick_start: float) -> EngineTick:
        await fx_provider.refresh()
        self._engine.usdt_rate = fx_provider.rate

        assert self._bti and self._bc
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
