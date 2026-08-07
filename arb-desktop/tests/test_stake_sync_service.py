from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus
from arb_desktop.execution.stake_sync_service import StakeSyncService, StakeSyncState
from arb_desktop.market_data.bithumb_fx import FxSnapshot, FxStatus
from arb_desktop.ui.settings_store import AppSettings


def _slips() -> tuple[BetSlipReadResult, BetSlipReadResult]:
    bc = BetSlipReadResult(
        site="bc",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bc", odds=1.92, status=SlipStatus.ACTIVE)],
    )
    bti = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bti", odds=2.13, status=SlipStatus.ACTIVE)],
    )
    return bc, bti


def test_stake_sync_can_sync_disabled() -> None:
    svc = StakeSyncService()
    bc, bti = _slips()
    settings = AppSettings(stake_sync_enabled=False)
    fx = FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=0.0, age_seconds=0.0)
    assert svc.can_sync(bridge_connected=True, bc=bc, bti=bti, fx=fx, settings=settings) == "disabled"


def test_stake_sync_compute_metrics() -> None:
    svc = StakeSyncService()
    bc, bti = _slips()
    settings = AppSettings(bti_stake_krw=100_000, usdt_rate=1400.0)
    fx = FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=0.0, age_seconds=0.0)
    metrics = svc.compute_metrics(bc=bc, bti=bti, settings=settings, fx=fx)
    assert metrics is not None
    assert metrics.bc_stake_usdt > 0


@pytest.mark.asyncio
async def test_stake_sync_writes_bc_input() -> None:
    svc = StakeSyncService()
    bc, bti = _slips()
    settings = AppSettings(bti_stake_krw=100_000, stake_sync_enabled=True)
    fx = FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=0.0, age_seconds=0.0)
    metrics = svc.compute_metrics(bc=bc, bti=bti, settings=settings, fx=fx)
    assert metrics

    server = MagicMock()
    server.send_command = AsyncMock(
        side_effect=[
            MagicMock(ok=True, actual=metrics.bc_stake_usdt, reason=""),
            MagicMock(ok=True, actual=metrics.bc_stake_usdt, reason=""),
        ]
    )
    status = await svc.sync_bc_stake(server=server, metrics=metrics, settings=settings)
    assert status.state == StakeSyncState.OK
    assert status.calculated_usdt == metrics.bc_stake_usdt


@pytest.mark.asyncio
async def test_stake_sync_input_not_found() -> None:
    svc = StakeSyncService()
    bc, bti = _slips()
    settings = AppSettings(stake_sync_enabled=True)
    fx = FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=0.0, age_seconds=0.0)
    metrics = svc.compute_metrics(bc=bc, bti=bti, settings=settings, fx=fx)
    assert metrics

    server = MagicMock()
    server.send_command = AsyncMock(return_value=MagicMock(ok=False, reason="stake-input-not-found", actual=None))
    status = await svc.sync_bc_stake(server=server, metrics=metrics, settings=settings)
    assert status.state == StakeSyncState.INPUT_NOT_FOUND
