from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from collections.abc import Awaitable, Callable
from typing import Any

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import OddsOnlyMetrics, compute_odds_only_metrics, odds_in_range
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.site_status import slip_status_from_read

logger = logging.getLogger(__name__)


class BetOutcome(str, Enum):
    BOTH_SUCCESS = "BOTH_SUCCESS"
    X10_SUCCESS_BC_FAILED = "X10_SUCCESS_BC_FAILED"
    BC_SUCCESS_X10_FAILED = "BC_SUCCESS_X10_FAILED"
    BOTH_FAILED = "BOTH_FAILED"
    UNKNOWN = "UNKNOWN"
    CANCELLED = "CANCELLED"
    DRY_RUN_MOCK = "DRY_RUN_MOCK"


@dataclass
class DispatchContext:
    bc: BetSlipReadResult
    bti: BetSlipReadResult
    metrics: OddsOnlyMetrics
    settings: AppSettings
    usdt_rate: float
    dom_hash_bc: str = ""
    dom_hash_x10: str = ""


@dataclass
class LegTiming:
    site: str
    prepare_done_at: float = 0.0
    click_started_at: float = 0.0
    click_completed_at: float = 0.0
    response_received_at: float = 0.0
    result: str = ""
    error: str = ""


@dataclass
class DispatchResult:
    execution_id: str
    outcome: BetOutcome
    abort_reason: str = ""
    dispatch_started_at: float = 0.0
    dispatch_gap_ms: float = 0.0
    completion_gap_ms: float = 0.0
    x10: LegTiming = field(default_factory=lambda: LegTiming(site="x10"))
    bc: LegTiming = field(default_factory=lambda: LegTiming(site="bc"))
    log_lines: list[str] = field(default_factory=list)

    @property
    def partial(self) -> bool:
        return self.outcome in {
            BetOutcome.X10_SUCCESS_BC_FAILED,
            BetOutcome.BC_SUCCESS_X10_FAILED,
        }


class ParallelBetOrchestrator:
    """양쪽 배팅 병렬 실행 — prepare 후 barrier에서 동시 release."""

    def __init__(self) -> None:
        self._global_lock = False
        self._last_execution_id: str | None = None
        self._last_dom_fingerprint: str | None = None
        self._last_dispatch_at: float = 0.0
        self._min_redispatch_sec: float = 3.0

    @property
    def is_locked(self) -> bool:
        return self._global_lock

    def _fingerprint(self, ctx: DispatchContext) -> str:
        bc = ctx.bc.first
        bti = ctx.bti.first
        return "|".join(
            [
                ctx.dom_hash_bc,
                ctx.dom_hash_x10,
                str(bc.odds if bc else ""),
                str(bti.odds if bti else ""),
                str(ctx.metrics.bc_stake_usdt),
                str(ctx.metrics.bti_stake_krw),
            ]
        )

    def pre_dispatch_validate(
        self,
        ctx: DispatchContext,
        *,
        manual: bool = False,
        skip_target_check: bool = False,
    ) -> str | None:
        bc = ctx.bc.first
        bti = ctx.bti.first
        if not bc or not bti:
            return "slip-missing"
        if slip_status_from_read(ctx.bc) != SlipStatus.ACTIVE:
            return "bc-closed-before-dispatch"
        if slip_status_from_read(ctx.bti) != SlipStatus.ACTIVE:
            return "x10-closed-before-dispatch"
        if len(ctx.bc.items) != 1 or len(ctx.bti.items) != 1:
            return "slip-count-not-one"
        if not odds_in_range(bc.odds) or not odds_in_range(bti.odds):
            return "odds-changed-before-dispatch"
        tol = ctx.settings.odds_change_tolerance
        if tol <= 0:
            if bc.odds != ctx.metrics.bc_odds or bti.odds != ctx.metrics.bti_odds:
                return "odds-changed-before-dispatch"
        else:
            if bc.odds and abs(bc.odds - ctx.metrics.bc_odds) > tol:
                return "odds-changed-before-dispatch"
            if bti.odds and abs(bti.odds - ctx.metrics.bti_odds) > tol:
                return "odds-changed-before-dispatch"
        if ctx.metrics.current_profit_rate < ctx.settings.target_profit_pct:
            if not (manual and skip_target_check):
                return "target-lost-before-dispatch"
        if manual:
            return None
        fp = self._fingerprint(ctx)
        if fp == self._last_dom_fingerprint and self._last_execution_id:
            return "duplicate-execution-blocked"
        return None

    async def dispatch(
        self,
        ctx: DispatchContext,
        *,
        dry_run: bool,
        live_enabled: bool,
        mock_fail_site: str | None = None,
        x10_click: Callable[[], Awaitable[Any]] | None = None,
        bc_click: Callable[[], Awaitable[Any]] | None = None,
        manual: bool = False,
        skip_target_check: bool = False,
    ) -> DispatchResult:
        execution_id = str(uuid.uuid4())
        result = DispatchResult(execution_id=execution_id, outcome=BetOutcome.UNKNOWN)

        if self._global_lock:
            result.outcome = BetOutcome.CANCELLED
            result.abort_reason = "execution-lock-active"
            return result

        now = time.time()
        if not manual and now - self._last_dispatch_at < self._min_redispatch_sec:
            result.outcome = BetOutcome.CANCELLED
            result.abort_reason = "redispatch-cooldown"
            return result

        abort = self.pre_dispatch_validate(ctx, manual=manual, skip_target_check=skip_target_check)
        if abort:
            result.outcome = BetOutcome.CANCELLED
            result.abort_reason = abort
            return result

        self._global_lock = True
        start_event = asyncio.Event()
        result.dispatch_started_at = time.perf_counter()

        async def prepare_leg(site: str, read: BetSlipReadResult, timing: LegTiming) -> bool:
            item = read.first
            if not item or item.status != SlipStatus.ACTIVE:
                timing.error = f"{site}-not-active"
                return False
            if item.odds is None:
                timing.error = f"{site}-odds-missing"
                return False
            timing.prepare_done_at = time.perf_counter()
            timing.result = "prepared"
            return True

        async def click_leg(site: str, timing: LegTiming, click_fn: Callable[[], Awaitable[Any]] | None) -> str:
            await start_event.wait()
            timing.click_started_at = time.perf_counter()
            if dry_run or not live_enabled:
                await asyncio.sleep(0.005)
                if mock_fail_site == site:
                    timing.error = "mock-failed"
                    timing.click_completed_at = time.perf_counter()
                    timing.response_received_at = timing.click_completed_at
                    timing.result = "mock-failed"
                    return "failed"
                timing.click_completed_at = time.perf_counter()
                timing.response_received_at = timing.click_completed_at
                timing.result = "mock-success"
                return "mock-success"
            if not click_fn:
                timing.error = "live-click-missing"
                timing.click_completed_at = time.perf_counter()
                return "failed"
            try:
                resp = await click_fn()
                ok = getattr(resp, "ok", True) if resp is not None else True
                timing.click_completed_at = time.perf_counter()
                timing.response_received_at = timing.click_completed_at
                if ok:
                    timing.result = "live-success"
                    return "live-success"
                timing.error = getattr(resp, "reason", None) or getattr(resp, "error", None) or "live-click-failed"
                timing.result = "live-failed"
                return "failed"
            except Exception as exc:
                timing.error = str(exc)
                timing.click_completed_at = time.perf_counter()
                timing.response_received_at = timing.click_completed_at
                timing.result = "live-failed"
                return "failed"

        try:
            x10_ready, bc_ready = await asyncio.gather(
                prepare_leg("x10", ctx.bti, result.x10),
                prepare_leg("bc", ctx.bc, result.bc),
            )

            lines = [
                "[BET PREPARE]",
                f"x10_ready={x10_ready}",
                f"bc_ready={bc_ready}",
                f"target_rate={ctx.settings.target_profit_pct:.2f}%",
                f"current_rate={ctx.metrics.current_profit_rate:.2f}%",
            ]
            result.log_lines.extend(lines)

            if not x10_ready or not bc_ready:
                result.outcome = BetOutcome.CANCELLED
                result.abort_reason = result.x10.error or result.bc.error or "prepare-failed"
                return result

            x10_task = asyncio.create_task(click_leg("x10", result.x10, x10_click))
            bc_task = asyncio.create_task(click_leg("bc", result.bc, bc_click))
            start_event.set()
            lines.append("[BET DISPATCH]")
            lines.append(f"dispatch_started_at={result.dispatch_started_at:.6f}")
            result.log_lines.extend(lines)

            x10_res, bc_res = await asyncio.gather(x10_task, bc_task, return_exceptions=True)

            success_vals = {"mock-success", "live-success"}
            x10_ok = x10_res in success_vals if not isinstance(x10_res, Exception) else False
            bc_ok = bc_res in success_vals if not isinstance(bc_res, Exception) else False

            if isinstance(x10_res, Exception):
                result.x10.error = str(x10_res)
            if isinstance(bc_res, Exception):
                result.bc.error = str(bc_res)

            starts = [t for t in (result.x10.click_started_at, result.bc.click_started_at) if t]
            if len(starts) == 2:
                result.dispatch_gap_ms = abs(starts[0] - starts[1]) * 1000

            completes = [t for t in (result.x10.click_completed_at, result.bc.click_completed_at) if t]
            if len(completes) == 2:
                result.completion_gap_ms = abs(completes[0] - completes[1]) * 1000

            if x10_ok and bc_ok:
                result.outcome = BetOutcome.DRY_RUN_MOCK if dry_run or not live_enabled else BetOutcome.BOTH_SUCCESS
            elif x10_ok and not bc_ok:
                result.outcome = BetOutcome.X10_SUCCESS_BC_FAILED
            elif bc_ok and not x10_ok:
                result.outcome = BetOutcome.BC_SUCCESS_X10_FAILED
            else:
                result.outcome = BetOutcome.BOTH_FAILED

            result.log_lines.extend(
                [
                    "[X10 BET]",
                    f"click_started_at={result.x10.click_started_at:.6f}",
                    f"click_completed_at={result.x10.click_completed_at:.6f}",
                    f"result={result.x10.result}",
                    "[BC BET]",
                    f"click_started_at={result.bc.click_started_at:.6f}",
                    f"click_completed_at={result.bc.click_completed_at:.6f}",
                    f"result={result.bc.result}",
                    "[BET TIMING]",
                    f"dispatch_gap_ms={result.dispatch_gap_ms:.2f}",
                    f"completion_gap_ms={result.completion_gap_ms:.2f}",
                ]
            )
            for line in result.log_lines:
                logger.info(line)

            self._last_execution_id = execution_id
            self._last_dom_fingerprint = self._fingerprint(ctx)
            self._last_dispatch_at = time.time()
            return result
        finally:
            self._global_lock = False

    def reset_lock(self) -> None:
        self._global_lock = False
