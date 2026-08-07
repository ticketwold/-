from __future__ import annotations

import asyncio

import pytest

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import compute_odds_only_metrics
from arb_desktop.execution.parallel_orchestrator import (
    BetOutcome,
    DispatchContext,
    ParallelBetOrchestrator,
)
from arb_desktop.ui.settings_store import AppSettings


def _ctx() -> DispatchContext:
    bc = BetSlipReadResult(
        site="bc",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bc", odds=2.1, status=SlipStatus.ACTIVE)],
    )
    bti = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bti", odds=2.05, status=SlipStatus.ACTIVE)],
    )
    settings = AppSettings(target_profit_pct=0.1, bti_stake_krw=10000, usdt_rate=1400.0)
    metrics = compute_odds_only_metrics(
        bti_odds=2.05,
        bc_odds=2.1,
        bti_stake_krw=10000,
        usdt_rate=1400.0,
        round_unit_krw=100,
        round_unit_usdt=0.1,
        target_profit_pct=0.1,
    )
    assert metrics is not None
    return DispatchContext(bc=bc, bti=bti, metrics=metrics, settings=settings, usdt_rate=1400.0)


@pytest.mark.asyncio
async def test_parallel_dry_run_dispatch() -> None:
    orch = ParallelBetOrchestrator()
    result = await orch.dispatch(_ctx(), dry_run=True, live_enabled=False)
    assert result.outcome == BetOutcome.DRY_RUN_MOCK
    assert result.dispatch_gap_ms < 50
    assert any("[BET TIMING]" in line for line in result.log_lines)


@pytest.mark.asyncio
async def test_parallel_partial_mock() -> None:
    orch = ParallelBetOrchestrator()
    result = await orch.dispatch(_ctx(), dry_run=True, live_enabled=False, mock_fail_site="bc")
    assert result.outcome == BetOutcome.X10_SUCCESS_BC_FAILED
    assert result.partial


@pytest.mark.asyncio
async def test_duplicate_execution_blocked() -> None:
    orch = ParallelBetOrchestrator()
    orch._min_redispatch_sec = 0
    ctx = _ctx()
    first = await orch.dispatch(ctx, dry_run=True, live_enabled=False)
    second = await orch.dispatch(ctx, dry_run=True, live_enabled=False)
    assert first.outcome == BetOutcome.DRY_RUN_MOCK
    assert second.outcome == BetOutcome.CANCELLED
    assert second.abort_reason == "duplicate-execution-blocked"


@pytest.mark.asyncio
async def test_closed_before_dispatch() -> None:
    orch = ParallelBetOrchestrator()
    ctx = _ctx()
    assert ctx.bc.first
    ctx.bc.first.status = SlipStatus.CLOSED
    abort = orch.pre_dispatch_validate(ctx)
    assert abort == "bc-closed-before-dispatch"
