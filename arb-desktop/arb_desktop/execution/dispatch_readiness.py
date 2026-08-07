from __future__ import annotations

from dataclasses import dataclass, field

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import odds_in_range
from arb_desktop.execution.stake_sync_service import StakeSyncService, StakeSyncState
from arb_desktop.market_data.bithumb_fx import FxSnapshot
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.site_status import slip_status_from_read
from arb_desktop.ui.watch_engine import WatchMetrics, WatchState


@dataclass
class DispatchReadiness:
    checklist: dict[str, str] = field(default_factory=dict)
    first_failure: str = ""
    can_dispatch: bool = False

    def label(self, name: str) -> str:
        return self.checklist.get(name, "—")


def assess_dispatch_readiness(
    *,
    metrics: WatchMetrics,
    settings: AppSettings,
    bridge_connected: bool,
    bc: BetSlipReadResult,
    bti: BetSlipReadResult,
    fx: FxSnapshot | None,
    stake_sync: StakeSyncService,
    watch_state: WatchState,
    watch_enabled: bool,
) -> DispatchReadiness:
    out = DispatchReadiness()
    c = out.checklist

    c["Bridge"] = "OK" if bridge_connected else "FAIL"
    c["X10 Slip"] = "OK" if not bti.empty and bti.first else "FAIL"
    c["BC Slip"] = "OK" if not bc.empty and bc.first else "FAIL"
    c["X10 Odds"] = "OK" if bti.first and odds_in_range(bti.first.odds) else "FAIL"
    c["BC Odds"] = "OK" if bc.first and odds_in_range(bc.first.odds) else "FAIL"

    sync_ok = True
    if settings.stake_sync_enabled:
        st = stake_sync.last_status
        sync_ok = st.state == StakeSyncState.OK and st.actual_usdt is not None
        if st.state == StakeSyncState.SYNCING:
            c["BC Stake Sync"] = "SYNC"
        elif sync_ok:
            c["BC Stake Sync"] = "OK"
        else:
            c["BC Stake Sync"] = "FAIL"
    else:
        c["BC Stake Sync"] = "OFF"

    fx_ok = metrics.fx_rate is not None and metrics.fx_status not in {"", "LOADING", "ERROR"}
    c["FX"] = "OK" if fx_ok else "FAIL"

    profit_ok = metrics.current_profit_rate >= settings.target_profit_pct
    c["Profit Target"] = "OK" if profit_ok else "FAIL"

    stable_ok = (
        metrics.stable_count >= metrics.stable_count_required
        and metrics.stabilize_elapsed >= metrics.stabilize_seconds
    )
    c["Stable Odds"] = "OK" if stable_ok or watch_state == WatchState.READY else "FAIL"

    x10_active = slip_status_from_read(bti) == SlipStatus.ACTIVE
    bc_active = slip_status_from_read(bc) == SlipStatus.ACTIVE
    c["X10 ACTIVE"] = "OK" if x10_active else "FAIL"
    c["BC ACTIVE"] = "OK" if bc_active else "FAIL"

    c["X10 Bet Button"] = "?" 
    c["BC Bet Button"] = "?"

    live_on = settings.live_execution_enabled
    c["Live Execution"] = "ON" if live_on else "OFF"
    c["Dry Run"] = "ON" if settings.dry_run else "OFF"
    c["Watch"] = "ON" if watch_enabled else "OFF"

    failures = []
    if c["Bridge"] == "FAIL":
        failures.append("bridge_disconnected")
    if c["X10 Slip"] == "FAIL":
        failures.append("x10_slip_missing")
    if c["BC Slip"] == "FAIL":
        failures.append("bc_slip_missing")
    if c["X10 Odds"] == "FAIL":
        failures.append("x10_odds_invalid")
    if c["BC Odds"] == "FAIL":
        failures.append("bc_odds_invalid")
    if settings.stake_sync_enabled and c["BC Stake Sync"] == "FAIL":
        failures.append("bc_stake_sync_failed")
    if c["FX"] == "FAIL":
        failures.append("fx_unavailable")
    if watch_enabled and c["Profit Target"] == "FAIL":
        failures.append("profit_target_not_met")
    if watch_enabled and c["Stable Odds"] == "FAIL" and watch_state != WatchState.READY:
        failures.append("stability_not_satisfied")
    if not watch_enabled:
        failures.append("watch_disabled")
    if not live_on:
        failures.append("live_execution_disabled")
    if settings.dry_run:
        failures.append("dry_run_enabled")

    out.first_failure = failures[0] if failures else ""
    out.can_dispatch = not failures and watch_state == WatchState.READY
    return out
