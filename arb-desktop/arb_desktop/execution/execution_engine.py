from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from enum import Enum

from arb_desktop.betslip.models import BetSlipReadResult
from arb_desktop.betslip.odds_only_calc import OddsOnlyMetrics, compute_odds_only_metrics
from arb_desktop.execution.exec_logger import get_exec_logger
from arb_desktop.execution.parallel_orchestrator import (
    BetOutcome,
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
            get_exec_logger().log("SYNC_BC_STAKE", ok=False, reason=block)
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
            return DispatchResult(execution_id="", outcome=BetOutcome.CANCELLED, abort_reason="locked")

        self._locked = True
        self.state.phase = ExecutionPhase.PREPARE
        self.state.message = "양쪽 병렬 배팅 준비 중"
        get_exec_logger().log("PREPARE")

        try:
            if not bridge_connected:
                get_exec_logger().log("PREPARE", ok=False, reason="bridge-disconnected")
                return DispatchResult(
                    execution_id="",
                    outcome=BetOutcome.CANCELLED,
                    abort_reason="bridge-disconnected",
                )

            ctx = self.build_context(bc=bc, bti=bti, settings=settings, fx=fx)
            if not ctx:
                return DispatchResult(execution_id="", outcome=BetOutcome.CANCELLED, abort_reason="calc-error")

            self.state.phase = ExecutionPhase.SYNC_STAKES
            sync_status = await self._stake_sync.sync_bc_stake(server=server, metrics=ctx.metrics, settings=settings)
            self.state.stake_sync = sync_status
            if settings.stake_sync_enabled and sync_status.state.name != "OK":
                get_exec_logger().log("PREPARE", ok=False, reason="bc_stake_sync_failed")
                return DispatchResult(
                    execution_id="",
                    outcome=BetOutcome.CANCELLED,
                    abort_reason="bc-stake-sync-failed",
                )

            # 최신 slip 기준으로 metrics 재계산
            ctx = self.build_context(bc=bc, bti=bti, settings=settings, fx=fx)
            if not ctx:
                return DispatchResult(execution_id="", outcome=BetOutcome.CANCELLED, abort_reason="calc-error")

            self.state.phase = ExecutionPhase.FINAL_RECHECK
            abort = self._orchestrator.pre_dispatch_validate(
                ctx,
                manual=manual,
                skip_target_check=skip_target_check,
            )
            profit_ok = ctx.metrics.current_profit_rate >= ctx.settings.target_profit_pct
            get_exec_logger().log(
                "FINAL_RECHECK",
                ok=abort is None,
                profit_rate=f"{ctx.metrics.current_profit_rate:.2f}",
                reason=abort or "",
            )
            skippable = {
                "target-lost-before-dispatch",
                "odds-changed-before-dispatch",
            }
            if abort and not (manual and skip_target_check and abort in skippable):
                result = DispatchResult(execution_id="", outcome=BetOutcome.CANCELLED, abort_reason=abort)
                self.state.last_result = result
                self.state.message = _abort_message(abort)
                self.state.phase = ExecutionPhase.FAILED
                return result

            live = settings.live_execution_enabled and settings.parallel_execution_enabled
            if manual and live:
                dry = False
            else:
                dry = settings.dry_run or not live

            if not live:
                get_exec_logger().log("DISPATCH", ok=False, reason="live_execution_disabled")
            elif dry:
                get_exec_logger().log("DISPATCH", ok=False, reason="dry_run_enabled")

            self.state.phase = ExecutionPhase.DISPATCH
            self.state.message = "양쪽 배팅 전송 중..." if not dry else "Dry Run — 양쪽 배팅 시뮬레이션..."
            get_exec_logger().log("DISPATCH", ok=live and not dry)

            x10_click_fn = None
            bc_click_fn = None
            if live and not dry and server:

                async def _x10_click():
                    get_exec_logger().log("X10_CLICK_START", timestamp_ns=time.time_ns())
                    return await server.send_command("x10", "place_x10_bet")

                async def _bc_click():
                    get_exec_logger().log("BC_CLICK_START", timestamp_ns=time.time_ns())
                    return await server.send_command("bc", "place_bc_bet")

                x10_click_fn = _x10_click
                bc_click_fn = _bc_click

            result = await self._orchestrator.dispatch(
                ctx,
                dry_run=dry,
                live_enabled=live,
                x10_click=x10_click_fn,
                bc_click=bc_click_fn,
                manual=manual,
                skip_target_check=skip_target_check,
            )

            self.state.dispatch_gap_ms = result.dispatch_gap_ms
            self.state.last_result = result
            self.state.phase = self._phase_from_result(result)
            get_exec_logger().log("VERIFY_RESULT", ok=result.outcome.name.endswith("SUCCESS"), outcome=result.outcome.value)
            if result.abort_reason:
                self.state.message = _abort_message(result.abort_reason)
            elif dry and result.outcome == BetOutcome.DRY_RUN_MOCK:
                self.state.message = "Dry Run 완료 (실제 Bet 클릭 없음)"
            else:
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


_ABORT_MESSAGES = {
    "bridge-disconnected": "Bridge 연결 필요",
    "calc-error": "수익률 계산 실패",
    "slip-missing": "양쪽 BetSlip 필요",
    "bc-closed-before-dispatch": "BC 배팅 닫힘",
    "x10-closed-before-dispatch": "X10 배팅 닫힘",
    "slip-count-not-one": "양쪽 카트는 각 1개여야 함",
    "odds-changed-before-dispatch": "배당 변경됨 — 재시도",
    "target-lost-before-dispatch": "목표 수익률 미달",
    "duplicate-execution-blocked": "중복 실행 차단",
    "redispatch-cooldown": "재실행 대기 중",
    "execution-lock-active": "실행 잠금",
    "bc-stake-sync-failed": "BC stake sync failed",
    "locked": "실행 잠금",
}


def _abort_message(reason: str) -> str:
    return _ABORT_MESSAGES.get(reason, reason.replace("-", " "))
