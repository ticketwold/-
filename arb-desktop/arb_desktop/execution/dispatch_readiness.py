from __future__ import annotations

from dataclasses import dataclass, field

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import odds_in_range
from arb_desktop.execution.stake_sync_service import StakeSyncService, StakeSyncState
from arb_desktop.market_data.bithumb_fx import FxSnapshot
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.site_status import slip_status_from_read
from arb_desktop.ui.watch_engine import WatchMetrics, WatchState

CHECKLIST_ORDER: tuple[str, ...] = (
    "Bridge",
    "X10 Cart",
    "BC Cart",
    "X10 Odds",
    "BC Odds",
    "BC Stake Input",
    "BC Stake Sync",
    "X10 Bet Button",
    "BC Bet Button",
    "Live Execution",
)


@dataclass
class DispatchReadiness:
    checklist: dict[str, str] = field(default_factory=dict)
    first_failure: str = ""
    can_dispatch: bool = False

    def label(self, name: str) -> str:
        return self.checklist.get(name, "—")


def _pass_fail(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


def build_exec_checklist(
    *,
    metrics: WatchMetrics,
    settings: AppSettings,
    bridge_connected: bool,
    bc: BetSlipReadResult,
    bti: BetSlipReadResult,
    fx: FxSnapshot | None,
    stake_sync: StakeSyncService,
    x10_bet_button: str = "?",
    bc_bet_button: str = "?",
) -> dict[str, str]:
    c: dict[str, str] = {}

    c["Bridge"] = _pass_fail(bridge_connected)
    c["X10 Cart"] = _pass_fail(not bti.empty and bool(bti.first))
    c["BC Cart"] = _pass_fail(not bc.empty and bool(bc.first))
    c["X10 Odds"] = _pass_fail(bool(bti.first and odds_in_range(bti.first.odds)))
    c["BC Odds"] = _pass_fail(bool(bc.first and odds_in_range(bc.first.odds)))

    st = stake_sync.last_status
    input_found = False
    if st and st.debug:
        input_found = bool(st.debug.get("found")) or bool(st.debug.get("selector"))
    if not input_found and metrics.bc_stake_input_found:
        input_found = True
    if st and st.state == StakeSyncState.OK and st.actual_usdt is not None:
        input_found = True
    c["BC Stake Input"] = _pass_fail(input_found) if settings.stake_sync_enabled else "OFF"

    if not settings.stake_sync_enabled:
        c["BC Stake Sync"] = "OFF"
    elif st.state == StakeSyncState.SYNCING:
        c["BC Stake Sync"] = "SYNC"
    elif st.state == StakeSyncState.OK and st.actual_usdt is not None:
        c["BC Stake Sync"] = "PASS"
    else:
        c["BC Stake Sync"] = "FAIL"

    c["X10 Bet Button"] = x10_bet_button if x10_bet_button in {"PASS", "FAIL"} else (
        "PASS" if x10_bet_button == "OK" else "FAIL" if x10_bet_button == "FAIL" else "?"
    )
    c["BC Bet Button"] = bc_bet_button if bc_bet_button in {"PASS", "FAIL"} else (
        "PASS" if bc_bet_button == "OK" else "FAIL" if bc_bet_button == "FAIL" else "?"
    )
    c["Live Execution"] = "ON" if settings.live_execution_enabled else "OFF"
    return c


def _ordered_failures(checklist: dict[str, str], keys: tuple[str, ...]) -> list[str]:
    failures: list[str] = []
    reason_map = {
        "Bridge": "bridge_disconnected",
        "X10 Cart": "x10_slip_missing",
        "BC Cart": "bc_slip_missing",
        "X10 Odds": "x10_odds_invalid",
        "BC Odds": "bc_odds_invalid",
        "BC Stake Input": "bc_stake_input_not_found",
        "BC Stake Sync": "bc_stake_sync_failed",
        "X10 Bet Button": "x10_bet_button_not_found",
        "BC Bet Button": "bc_bet_button_not_found",
        "Live Execution": "live_execution_disabled",
    }
    for key in keys:
        val = checklist.get(key, "?")
        if val == "FAIL":
            failures.append(reason_map.get(key, key))
    return failures


def assess_manual_dispatch_readiness(
    *,
    metrics: WatchMetrics,
    settings: AppSettings,
    bridge_connected: bool,
    bc: BetSlipReadResult,
    bti: BetSlipReadResult,
    fx: FxSnapshot | None,
    stake_sync: StakeSyncService,
    x10_bet_button: str = "?",
    bc_bet_button: str = "?",
) -> DispatchReadiness:
    out = DispatchReadiness()
    out.checklist = build_exec_checklist(
        metrics=metrics,
        settings=settings,
        bridge_connected=bridge_connected,
        bc=bc,
        bti=bti,
        fx=fx,
        stake_sync=stake_sync,
        x10_bet_button=x10_bet_button,
        bc_bet_button=bc_bet_button,
    )
    keys: tuple[str, ...] = (
        "Bridge",
        "X10 Cart",
        "BC Cart",
        "X10 Odds",
        "BC Odds",
    )
    if settings.stake_sync_enabled:
        keys = (*keys, "BC Stake Input", "BC Stake Sync")
    if settings.live_execution_enabled:
        keys = (*keys, "Live Execution")
    failures = _ordered_failures(out.checklist, keys)
    out.first_failure = failures[0] if failures else ""
    out.can_dispatch = not failures
    return out


def assess_auto_dispatch_readiness(
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
    x10_bet_button: str = "?",
    bc_bet_button: str = "?",
) -> DispatchReadiness:
    out = assess_manual_dispatch_readiness(
        metrics=metrics,
        settings=settings,
        bridge_connected=bridge_connected,
        bc=bc,
        bti=bti,
        fx=fx,
        stake_sync=stake_sync,
        x10_bet_button=x10_bet_button,
        bc_bet_button=bc_bet_button,
    )
    failures = _ordered_failures(out.checklist, CHECKLIST_ORDER)
    if not watch_enabled:
        failures.insert(0, "watch_disabled")
    if watch_state != WatchState.READY:
        failures.insert(0, "not_ready")
    if metrics.current_profit_rate < settings.target_profit_pct:
        failures.append("profit_target_not_met")
    stable_ok = (
        metrics.stable_count >= metrics.stable_count_required
        and metrics.stabilize_elapsed >= metrics.stabilize_seconds
    )
    if not stable_ok and watch_state != WatchState.READY:
        failures.append("stability_not_satisfied")
    fx_ok = metrics.fx_rate is not None and metrics.fx_status not in {"", "LOADING", "ERROR", "fx-api-error"}
    if not fx_ok:
        failures.append("fx_unavailable")
    x10_active = slip_status_from_read(bti) == SlipStatus.ACTIVE
    bc_active = slip_status_from_read(bc) == SlipStatus.ACTIVE
    if not x10_active or not bc_active:
        failures.append("site_not_active")
    if settings.dry_run and not settings.parallel_dry_run_on_ready:
        failures.append("dry_run_enabled")
    # dedupe preserving order
    seen: set[str] = set()
    ordered: list[str] = []
    for f in failures:
        if f not in seen:
            seen.add(f)
            ordered.append(f)
    out.first_failure = ordered[0] if ordered else ""
    out.can_dispatch = not ordered and watch_state == WatchState.READY and watch_enabled
    return out


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
    x10_bet_button: str = "?",
    bc_bet_button: str = "?",
) -> DispatchReadiness:
    """Backward-compatible wrapper — auto path when watch is on, else checklist only."""
    if watch_enabled:
        return assess_auto_dispatch_readiness(
            metrics=metrics,
            settings=settings,
            bridge_connected=bridge_connected,
            bc=bc,
            bti=bti,
            fx=fx,
            stake_sync=stake_sync,
            watch_state=watch_state,
            watch_enabled=watch_enabled,
            x10_bet_button=x10_bet_button,
            bc_bet_button=bc_bet_button,
        )
    out = DispatchReadiness()
    out.checklist = build_exec_checklist(
        metrics=metrics,
        settings=settings,
        bridge_connected=bridge_connected,
        bc=bc,
        bti=bti,
        fx=fx,
        stake_sync=stake_sync,
        x10_bet_button=x10_bet_button,
        bc_bet_button=bc_bet_button,
    )
    return out
