from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus
from arb_desktop.execution.execution_engine import ExecutionEngine, ExecutionPhase
from arb_desktop.execution.parallel_orchestrator import BetOutcome
from arb_desktop.market_data.bithumb_fx import FxSnapshot, FxStatus
from arb_desktop.ui.settings_store import AppSettings


def _reads() -> tuple[BetSlipReadResult, BetSlipReadResult]:
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
    return bc, bti


@pytest.mark.asyncio
async def test_execution_engine_dry_run_manual() -> None:
    engine = ExecutionEngine()
    engine._orchestrator._min_redispatch_sec = 0
    bc, bti = _reads()
    settings = AppSettings(target_profit_pct=0.1, bti_stake_krw=10_000, dry_run=True, stake_sync_enabled=False)
    fx = FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=0.0, age_seconds=0.0)
    server = MagicMock()
    server.send_command = AsyncMock(return_value=MagicMock(ok=True, actual=7.5))

    result = await engine.prepare_and_dispatch(
        server=server,
        bridge_connected=True,
        bc=bc,
        bti=bti,
        settings=settings,
        fx=fx,
        manual=True,
        skip_target_check=False,
    )
    assert result.outcome == BetOutcome.DRY_RUN_MOCK
    assert engine.state.phase in {ExecutionPhase.SUCCESS, ExecutionPhase.IDLE}


@pytest.mark.asyncio
async def test_execution_engine_live_click_callbacks() -> None:
    engine = ExecutionEngine()
    engine._orchestrator._min_redispatch_sec = 0
    bc, bti = _reads()
    settings = AppSettings(
        target_profit_pct=0.1,
        bti_stake_krw=10_000,
        dry_run=False,
        live_execution_enabled=True,
        parallel_execution_enabled=True,
        stake_sync_enabled=True,
    )
    fx = FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=0.0, age_seconds=0.0)
    server = MagicMock()
    calc = engine.build_context(bc=bc, bti=bti, settings=settings, fx=fx)
    assert calc
    target = calc.metrics.bc_stake_usdt

    async def _cmd(site, command, **kwargs):
        if command == "set_bc_stake":
            return MagicMock(ok=True, actual=target, reason="ok")
        if command == "read_bc_stake":
            return MagicMock(ok=True, actual=target, reason="")
        if command in {"place_x10_bet", "place_bc_bet"}:
            return MagicMock(ok=True)
        return MagicMock(ok=True)

    server.send_command = AsyncMock(side_effect=_cmd)

    result = await engine.prepare_and_dispatch(
        server=server,
        bridge_connected=True,
        bc=bc,
        bti=bti,
        settings=settings,
        fx=fx,
        manual=True,
    )
    assert result.outcome == BetOutcome.BOTH_SUCCESS
    assert server.send_command.await_count >= 2
