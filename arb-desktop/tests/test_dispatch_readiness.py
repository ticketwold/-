from __future__ import annotations

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus
from arb_desktop.execution.dispatch_readiness import (
    assess_manual_dispatch_readiness,
    build_exec_checklist,
)
from arb_desktop.execution.stake_sync_service import StakeSyncService, StakeSyncStatus, StakeSyncState
from arb_desktop.market_data.bithumb_fx import FxSnapshot, FxStatus
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.watch_engine import WatchMetrics, WatchState


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


def test_manual_dispatch_does_not_require_watch() -> None:
    bc, bti = _reads()
    svc = StakeSyncService()
    svc.last_status = StakeSyncStatus(state=StakeSyncState.OK, actual_usdt=5.7, debug={"found": True})
    settings = AppSettings(
        live_execution_enabled=True,
        stake_sync_enabled=True,
        target_profit_pct=99.0,
    )
    metrics = WatchMetrics(current_profit_rate=1.0, target_profit_pct=99.0)
    fx = FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=0.0, age_seconds=0.0)
    ready = assess_manual_dispatch_readiness(
        metrics=metrics,
        settings=settings,
        bridge_connected=True,
        bc=bc,
        bti=bti,
        fx=fx,
        stake_sync=svc,
        x10_bet_button="PASS",
        bc_bet_button="PASS",
    )
    assert ready.can_dispatch
    assert ready.checklist["BC Stake Sync"] == "PASS"


def test_build_exec_checklist_uses_pass_fail_labels() -> None:
    bc, bti = _reads()
    svc = StakeSyncService()
    svc.last_status = StakeSyncStatus(state=StakeSyncState.OK, actual_usdt=5.7, debug={"found": True})
    checklist = build_exec_checklist(
        metrics=WatchMetrics(),
        settings=AppSettings(live_execution_enabled=False),
        bridge_connected=True,
        bc=bc,
        bti=bti,
        fx=FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=0.0, age_seconds=0.0),
        stake_sync=svc,
        x10_bet_button="PASS",
        bc_bet_button="FAIL",
    )
    assert checklist["Bridge"] == "PASS"
    assert checklist["BC Stake Input"] == "PASS"
    assert checklist["X10 Bet Button"] == "PASS"
    assert checklist["BC Bet Button"] == "FAIL"
    assert checklist["Live Execution"] == "OFF"
