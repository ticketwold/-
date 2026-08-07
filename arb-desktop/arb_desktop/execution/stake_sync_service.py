from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import OddsOnlyMetrics, compute_odds_only_metrics, odds_in_range
from arb_desktop.bridge.command_bus import CommandResult
from arb_desktop.execution.exec_logger import get_exec_logger
from arb_desktop.market_data.bithumb_fx import FxSnapshot
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.site_status import both_sites_active, slip_status_from_read

REASON_MESSAGES = {
    "input-not-found": "input-not-found",
    "stake-input-not-found": "input-not-found",
    "frame-not-found": "frame-lost",
    "frame-lost": "frame-lost",
    "value-not-applied": "value-not-applied",
    "react-reset-value": "react-reset",
    "react-reset": "react-reset",
    "input-disabled": "disabled",
    "disabled": "disabled",
    "readonly": "readonly",
    "command-timeout": "command-timeout",
    "stake-sync-failed": "stake-sync-failed",
    "ok": "ok",
}


def normalize_reason(reason: str) -> str:
    r = (reason or "").strip().lower()
    if r in REASON_MESSAGES:
        return REASON_MESSAGES[r]
    if "not-found" in r:
        return "input-not-found"
    if "disabled" in r:
        return "disabled"
    if "react-reset" in r:
        return "react-reset"
    if "frame" in r:
        return "frame-lost"
    return r or "stake-sync-failed"


class StakeSyncState(str, Enum):
    IDLE = "IDLE"
    SYNCING = "SYNCING"
    OK = "OK"
    FAILED = "FAILED"
    INPUT_NOT_FOUND = "INPUT_NOT_FOUND"
    WAITING = "WAITING"


@dataclass
class StakeSyncStatus:
    state: StakeSyncState = StakeSyncState.IDLE
    calculated_usdt: float | None = None
    actual_usdt: float | None = None
    message: str = ""
    reason: str = ""
    debug: dict = field(default_factory=dict)


@dataclass
class StakeSyncService:
    """BC stake 상시 자동동기화 — watch_enabled와 독립."""

    last_status: StakeSyncStatus = None  # type: ignore[assignment]
    _last_target: float | None = None

    def __post_init__(self) -> None:
        self.last_status = StakeSyncStatus()

    def can_sync(
        self,
        *,
        bridge_connected: bool,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        fx: FxSnapshot | None,
        settings: AppSettings,
    ) -> str | None:
        if not settings.stake_sync_enabled:
            return "disabled"
        if not bridge_connected:
            return "bridge-disconnected"
        if bc.empty or not bc.first or bti.empty or not bti.first:
            return "slip-missing"
        bc_st = slip_status_from_read(bc)
        x10_st = slip_status_from_read(bti)
        if not both_sites_active(bc_st, x10_st):
            return "site-not-active"
        if not odds_in_range(bc.first.odds) or not odds_in_range(bti.first.odds):
            return "odds-missing"
        rate = _fx_rate(settings, fx)
        if rate is None:
            return "fx-unavailable"
        return None

    def compute_metrics(
        self,
        *,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        settings: AppSettings,
        fx: FxSnapshot | None,
    ) -> OddsOnlyMetrics | None:
        rate = _fx_rate(settings, fx)
        if rate is None or not bc.first or not bti.first:
            return None
        return compute_odds_only_metrics(
            bti_odds=float(bti.first.odds or 0),
            bc_odds=float(bc.first.odds or 0),
            bti_stake_krw=settings.bti_stake_krw,
            usdt_rate=rate,
            round_unit_krw=settings.round_unit_krw,
            round_unit_usdt=settings.round_unit_usdt,
            target_profit_pct=settings.target_profit_pct,
        )

    async def sync_bc_stake(
        self,
        *,
        server,
        metrics: OddsOnlyMetrics,
        settings: AppSettings,
    ) -> StakeSyncStatus:
        elog = get_exec_logger()
        elog.begin_stake_sync()

        if not settings.stake_sync_enabled:
            elog.stake_step("CALCULATE", ok=False, reason="stake_sync_disabled")
            self.last_status = StakeSyncStatus(state=StakeSyncState.IDLE, message="OFF")
            return self.last_status

        target = float(metrics.bc_stake_usdt)
        elog.stake_step(
            "CALCULATE",
            ok=True,
            reason="ok",
            requested=f"{target:.4f}",
            x10_odds=metrics.bti_odds,
            bc_odds=metrics.bc_odds,
        )

        if self._last_target is not None and abs(self._last_target - target) < 0.05:
            if self.last_status.state == StakeSyncState.OK and self.last_status.actual_usdt is not None:
                if abs(self.last_status.actual_usdt - target) <= 0.15:
                    for step in ("SEND", "CONTENT_RX", "INPUT_FOUND", "WRITE", "VERIFY"):
                        elog.stake_step(step, ok=True, reason="skipped unchanged")
                    elog.stake_step("ACK", ok=True, reason="skipped unchanged")
                    return self.last_status

        self._last_target = target
        self.last_status = StakeSyncStatus(
            state=StakeSyncState.SYNCING,
            calculated_usdt=target,
            message="동기화 중...",
        )

        try:
            write: CommandResult = await server.send_command(
                "bc",
                "set_bc_stake",
                amount_usdt=target,
            )
            elog.stake_step("SEND", ok=True, reason="set_bc_stake sent", requested=f"{target:.4f}")
        except Exception as exc:
            elog.stake_step("SEND", ok=False, reason=str(exc))
            self.last_status = StakeSyncStatus(
                state=StakeSyncState.FAILED,
                calculated_usdt=target,
                reason="command-timeout",
                message=str(exc),
            )
            return self.last_status

        debug = write.raw.get("debug") if isinstance(write.raw.get("debug"), dict) else write.raw
        reason = normalize_reason(write.reason or write.error or "")
        verify = debug.get("verify") if isinstance(debug, dict) else {}
        checks = verify.get("checks") if isinstance(verify, dict) else {}
        if not isinstance(checks, dict):
            checks = {}

        elog.stake_step(
            "CONTENT_RX",
            ok=True,
            reason=write.reason or write.error or "ok",
            actual=write.actual,
        )

        input_found = bool(debug.get("selected_selector") if isinstance(debug, dict) else False) or write.ok
        if not input_found:
            elog.stake_step(
                "INPUT_FOUND",
                ok=False,
                reason=reason or "stake-input-not-found",
                before=debug.get("before_value") if isinstance(debug, dict) else None,
            )
            state = StakeSyncState.INPUT_NOT_FOUND if reason == "input-not-found" else StakeSyncState.FAILED
            self.last_status = StakeSyncStatus(
                state=state,
                calculated_usdt=target,
                actual_usdt=write.actual,
                reason=reason,
                message=_reason_message(reason),
                debug=debug if isinstance(debug, dict) else {},
            )
            return self.last_status

        elog.stake_step(
            "INPUT_FOUND",
            ok=True,
            reason="ok",
            selector=debug.get("selected_selector") if isinstance(debug, dict) else None,
            before=debug.get("before_value") if isinstance(debug, dict) else None,
        )

        if not write.ok:
            elog.stake_step("WRITE", ok=False, reason=reason or "write failed", after=write.actual)
            state = StakeSyncState.INPUT_NOT_FOUND if reason == "input-not-found" else StakeSyncState.FAILED
            self.last_status = StakeSyncStatus(
                state=state,
                calculated_usdt=target,
                actual_usdt=write.actual,
                reason=reason,
                message=_reason_message(reason),
                debug=debug if isinstance(debug, dict) else {},
            )
            return self.last_status

        actual = write.actual
        if actual is None:
            elog.stake_step("WRITE", ok=False, reason="no actual value returned")
            self.last_status = StakeSyncStatus(
                state=StakeSyncState.INPUT_NOT_FOUND,
                calculated_usdt=target,
                actual_usdt=None,
                reason="input-not-found",
                message="input-not-found",
                debug=debug if isinstance(debug, dict) else {},
            )
            return self.last_status

        elog.stake_step("WRITE", ok=True, reason="ok", after=f"{actual:.4f}")

        ok = abs(actual - target) <= 0.15
        elog.stake_step(
            "VERIFY",
            ok=ok,
            reason=reason or ("ok" if ok else "value-not-applied"),
            verify=f"{actual:.4f}",
            requested=f"{target:.4f}",
            ms50=checks.get("50ms"),
            ms100=checks.get("100ms"),
            ms250=checks.get("250ms"),
        )
        if not ok:
            self.last_status = StakeSyncStatus(
                state=StakeSyncState.FAILED,
                calculated_usdt=target,
                actual_usdt=actual,
                reason=reason or "value-not-applied",
                message=_reason_message(reason or "value-not-applied"),
                debug=debug if isinstance(debug, dict) else {},
            )
            return self.last_status

        elog.stake_step("ACK", ok=True, reason="stake sync complete", actual=f"{actual:.4f}")
        self.last_status = StakeSyncStatus(
            state=StakeSyncState.OK,
            calculated_usdt=target,
            actual_usdt=actual,
            reason=reason or "ok",
            message="동기화 완료",
            debug=debug if isinstance(debug, dict) else {},
        )
        return self.last_status

    async def scan_bc_stake(self, *, server) -> StakeSyncStatus:
        elog = get_exec_logger()
        elog.begin_stake_sync()
        elog.stake_step("CALCULATE", ok=True, reason="scan mode")

        try:
            scan: CommandResult = await server.send_command("bc", "scan_bc_stake")
            elog.stake_step("SEND", ok=True, reason="scan_bc_stake sent")
        except Exception as exc:
            elog.stake_step("SEND", ok=False, reason=str(exc))
            self.last_status = StakeSyncStatus(state=StakeSyncState.FAILED, reason=str(exc))
            return self.last_status

        debug = scan.raw.get("debug") if isinstance(scan.raw.get("debug"), dict) else scan.raw
        found = bool(scan.raw.get("found")) or bool(scan.ok and scan.raw.get("selector"))
        reason = scan.reason or scan.error or ("ok" if found else "stake-input-not-found")

        elog.stake_step("CONTENT_RX", ok=True, reason=reason)
        elog.stake_step("INPUT_FOUND", ok=found, reason=reason if not found else "ok")
        elog.stake_step("WRITE", ok=True, reason="skipped scan")
        elog.stake_step("VERIFY", ok=True, reason="skipped scan")
        elog.stake_step("ACK", ok=found, reason=reason if not found else "scan complete")

        self.last_status = StakeSyncStatus(
            state=StakeSyncState.OK if found else StakeSyncState.INPUT_NOT_FOUND,
            actual_usdt=scan.actual,
            reason=reason,
            message="FOUND" if found else _reason_message("stake-input-not-found"),
            debug=debug if isinstance(debug, dict) else {},
        )
        if isinstance(debug, dict):
            self.last_status.debug = {
                **debug,
                "found": found,
                "selector": scan.raw.get("selector") or debug.get("selector"),
                "frame_url": scan.raw.get("frame_url") or debug.get("frame_url"),
                "current_value": scan.raw.get("current_value") or debug.get("current_value"),
            }
        return self.last_status

    async def test_bc_stake(self, *, server, amount_usdt: float) -> StakeSyncStatus:
        elog = get_exec_logger()
        elog.begin_stake_sync()
        target = max(0.1, round(float(amount_usdt), 1))
        elog.stake_step("CALCULATE", ok=True, reason="test mode", requested=f"{target:.4f}")

        try:
            write: CommandResult = await server.send_command(
                "bc",
                "set_bc_stake",
                amount_usdt=target,
                test=True,
            )
            elog.stake_step("SEND", ok=True, reason="test set_bc_stake sent")
        except Exception as exc:
            elog.stake_step("SEND", ok=False, reason=str(exc))
            self.last_status = StakeSyncStatus(state=StakeSyncState.FAILED, reason=str(exc))
            return self.last_status

        debug = write.raw.get("debug") if isinstance(write.raw.get("debug"), dict) else write.raw
        reason = write.reason or write.error or "stake-input-not-found"
        ok = bool(write.ok and write.actual is not None)

        elog.stake_step("CONTENT_RX", ok=True, reason=reason)
        input_found = bool(debug.get("selected_selector") if isinstance(debug, dict) else False) or write.ok
        elog.stake_step("INPUT_FOUND", ok=input_found, reason=reason if not input_found else "ok")
        elog.stake_step("WRITE", ok=ok, reason=reason if not ok else "ok", after=write.actual)
        elog.stake_step("VERIFY", ok=ok, reason=reason if not ok else "ok", actual=write.actual)
        elog.stake_step("ACK", ok=ok, reason=reason if not ok else "test complete")

        self.last_status = StakeSyncStatus(
            state=StakeSyncState.OK if ok else StakeSyncState.INPUT_NOT_FOUND if "not-found" in reason else StakeSyncState.FAILED,
            calculated_usdt=target,
            actual_usdt=write.actual,
            reason=reason,
            message="테스트 성공" if ok else _reason_message(reason),
            debug=debug if isinstance(debug, dict) else {},
        )
        return self.last_status


def _reason_message(reason: str) -> str:
    norm = normalize_reason(reason)
    if norm == "ok":
        return "동기화 완료"
    return norm


def _fx_rate(settings: AppSettings, fx: FxSnapshot | None) -> float | None:
    if settings.fx_auto_enabled and fx and fx.rate is not None:
        if fx.is_usable(settings.fx_max_stale_seconds):
            return fx.rate
        return None
    if settings.usdt_rate > 0:
        return settings.usdt_rate
    return fx.rate if fx and fx.rate else None
