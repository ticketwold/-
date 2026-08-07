from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

from arb_desktop.betslip.models import BetSlipReadResult
from arb_desktop.betslip.odds_only_calc import OddsOnlyMetrics, compute_odds_only_metrics
from arb_desktop.execution.parallel_orchestrator import (
    DispatchContext,
    DispatchResult,
    ParallelBetOrchestrator,
)
from arb_desktop.execution.stake_sync_service import StakeSyncService, StakeSyncStatus
from arb_desktop.market_data.bithumb_fx import FxSnapshot
from arb_desktop.ui.settings_store import AppSettings

logger = logging.getLogger(__name__)


class ExecutionPhase(str, Enum):
    IDLE = "IDLE"
    PREPARE = "PREPARE"
    FINAL_RECHECK = "FINAL_RECHECK"
    SYNC_STAKES = "SYNC_STAKES"
    DISPATCH = "DISPATCH"
    VERIFY = "VERIFY"
    SUCCESS = "SUCCESS"
    PARTIAL = "PARTIAL BET"
    FAILED = "FAILED"


@dataclass
class ExecutionState:
    phase: ExecutionPhase = ExecutionPhase.IDLE
    message: str = ""
    dispatch_gap_ms: float = 0.0
    last_result: DispatchResult | None = None
    stake_sync: StakeSyncStatus | None = None


class ExecutionEngine:
    """자동/수동 배팅 공통 실행 엔진."""

    def __init__(self) -> None:
        self._orchestrator = ParallelBetOrchestrator()
        self._stake_sync = StakeSyncService()
        self.state = ExecutionState()
        self._locked = False

    @property
    def is_locked(self) -> bool:
        return self._locked or self._orchestrator.is_locked

    @property
    def stake_sync(self) -> StakeSyncService:
        return self._stake_sync

    async def maybe_sync_stakes(
        self,
        *,
        server,
        bridge_connected: bool,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        settings: AppSettings,
        fx: FxSnapshot | None,
    ) -> StakeSyncStatus | None:
        block = self._stake_sync.can_sync(
            bridge_connected=bridge_connected,
            bc=bc,
            bti=bti,
            fx=fx,
            settings=settings,
        )
        if block:
            self.state.stake_sync = StakeSyncStatus(
                message=block,
            )
            return self.state.stake_sync
        metrics = self._stake_sync.compute_metrics(bc=bc, bti=bti, settings=settings, fx=fx)
        if not metrics:
            return None
        status = await self._stake_sync.sync_bc_stake(
            server=server,
            metrics=metrics,
            settings=settings,
        )
        self.state.stake_sync = status
        return status

    def build_context(
        self,
        *,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        settings: AppSettings,
        fx: FxSnapshot | None,
        metrics: OddsOnlyMetrics | None = None,
    ) -> DispatchContext | None:
        rate = settings.usdt_rate
        if fx and fx.rate:
            rate = fx.rate
        if not metrics:
            metrics = compute_odds_only_metrics(
                bti_odds=float(bti.first.odds or 0) if bti.first else 0,
                bc_odds=float(bc.first.odds or 0) if bc.first else 0,
                bti_stake_krw=settings.bti_stake_krw,
                usdt_rate=rate,
                round_unit_krw=settings.round_unit_krw,
                round_unit_usdt=settings.round_unit_usdt,
                target_profit_pct=settings.target_profit_pct,
            )
        if not metrics:
            return None
        return DispatchContext(
            bc=bc,
            bti=bti,
            metrics=metrics,
            settings=settings,
            usdt_rate=rate,
            dom_hash_bc=str(bc.first.dom_hash if bc.first else ""),
            dom_hash_x10=str(bti.first.dom_hash if bti.first else ""),
        )

    async def prepare_and_dispatch(
        self,
        *,
        server,
        bridge_connected: bool,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        settings: AppSettings,
        fx: FxSnapshot | None,
        manual: bool = False,
        skip_target_check: bool = False,
    ) -> DispatchResult:
        if self.is_locked:
            from arb_desktop.execution.parallel_orchestrator import BetOutcome, DispatchResult

            return DispatchResult(execution_id="", outcome=BetOutcome.CANCELLED, abort_reason="locked")

        self._locked = True
        self.state.phase = ExecutionPhase.PREPARE
        self.state.message = "양쪽 병렬 배팅 준비 중"

        try:
            ctx = self.build_context(bc=bc, bti=bti, settings=settings, fx=fx)
            if not ctx:
                from arb_desktop.execution.parallel_orchestrator import BetOutcome, DispatchResult

                return DispatchResult(execution_id="", outcome=BetOutcome.CANCELLED, abort_reason="calc-error")

            self.state.phase = ExecutionPhase.SYNC_STAKES
            await self._stake_sync.sync_bc_stake(server=server, metrics=ctx.metrics, settings=settings)

            self.state.phase = ExecutionPhase.FINAL_RECHECK
            abort = self._orchestrator.pre_dispatch_validate(ctx)
            if abort and not (manual and skip_target_check and abort == "target-lost-before-dispatch"):
                from arb_desktop.execution.parallel_orchestrator import BetOutcome, DispatchResult

                return DispatchResult(execution_id="", outcome=BetOutcome.CANCELLED, abort_reason=abort)

            live = settings.live_execution_enabled and settings.parallel_execution_enabled
            dry = settings.dry_run or not live

            self.state.phase = ExecutionPhase.DISPATCH
            self.state.message = "양쪽 배팅 전송 중..."

            x10_click_fn = None
            bc_click_fn = None
            if live and not dry and server:

                async def _x10_click():
                    return await server.send_command("x10", "place_x10_bet")

                async def _bc_click():
                    return await server.send_command("bc", "place_bc_bet")

                x10_click_fn = _x10_click
                bc_click_fn = _bc_click

            result = await self._orchestrator.dispatch(
                ctx,
                dry_run=dry,
                live_enabled=live,
                x10_click=x10_click_fn,
                bc_click=bc_click_fn,
            )

            self.state.dispatch_gap_ms = result.dispatch_gap_ms
            self.state.last_result = result
            self.state.phase = self._phase_from_result(result)
            self.state.message = result.outcome.value
            return result
        finally:
            self._locked = False

    @staticmethod
    def _phase_from_result(result: DispatchResult) -> ExecutionPhase:
        if result.partial:
            return ExecutionPhase.PARTIAL
        if result.outcome.name.endswith("SUCCESS") or result.outcome.value == "DRY_RUN_MOCK":
            return ExecutionPhase.SUCCESS
        if result.outcome.name == "CANCELLED":
            return ExecutionPhase.IDLE
        return ExecutionPhase.FAILED
