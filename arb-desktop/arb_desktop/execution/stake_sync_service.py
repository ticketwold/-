from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import OddsOnlyMetrics, compute_odds_only_metrics, odds_in_range
from arb_desktop.bridge.command_bus import CommandResult
from arb_desktop.market_data.bithumb_fx import FxSnapshot
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.site_status import both_sites_active, slip_status_from_read

REASON_MESSAGES = {
    "stake-input-not-found": "입력창을 찾지 못함",
    "frame-not-found": "BetSlip 프레임을 찾지 못함",
    "value-not-applied": "입력값이 적용되지 않음",
    "react-reset-value": "사이트가 입력값을 다시 초기화함",
    "input-disabled": "입력창이 비활성화됨",
    "command-timeout": "명령 시간 초과",
    "stake-sync-failed": "동기화 실패",
}


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
        if not settings.stake_sync_enabled:
            self.last_status = StakeSyncStatus(state=StakeSyncState.IDLE, message="OFF")
            return self.last_status

        target = float(metrics.bc_stake_usdt)
        if self._last_target is not None and abs(self._last_target - target) < 0.05:
            if self.last_status.state == StakeSyncState.OK and self.last_status.actual_usdt is not None:
                if abs(self.last_status.actual_usdt - target) <= 0.15:
                    return self.last_status

        self._last_target = target
        self.last_status = StakeSyncStatus(
            state=StakeSyncState.SYNCING,
            calculated_usdt=target,
            message="동기화 중...",
        )

        write: CommandResult = await server.send_command(
            "bc",
            "set_bc_stake",
            amount_usdt=target,
        )
        debug = write.raw.get("debug") if isinstance(write.raw.get("debug"), dict) else write.raw
        reason = write.reason or write.error or ""

        if not write.ok:
            state = StakeSyncState.INPUT_NOT_FOUND if "not-found" in reason else StakeSyncState.FAILED
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
        ok = actual is not None and abs(actual - target) <= 0.15
        self.last_status = StakeSyncStatus(
            state=StakeSyncState.OK if ok else StakeSyncState.FAILED,
            calculated_usdt=target,
            actual_usdt=actual,
            reason=reason or ("ok" if ok else "value-not-applied"),
            message="동기화 완료" if ok else _reason_message(reason or "value-not-applied"),
            debug=debug if isinstance(debug, dict) else {},
        )
        return self.last_status

    async def test_bc_stake(self, *, server, amount_usdt: float) -> StakeSyncStatus:
        target = max(0.1, round(float(amount_usdt), 1))
        write: CommandResult = await server.send_command(
            "bc",
            "set_bc_stake",
            amount_usdt=target,
            test=True,
        )
        debug = write.raw.get("debug") if isinstance(write.raw.get("debug"), dict) else write.raw
        reason = write.reason or write.error or "stake-input-not-found"
        ok = bool(write.ok)
        self.last_status = StakeSyncStatus(
            state=StakeSyncState.OK if ok else StakeSyncState.FAILED,
            calculated_usdt=target,
            actual_usdt=write.actual,
            reason=reason,
            message="테스트 성공" if ok else _reason_message(reason),
            debug=debug if isinstance(debug, dict) else {},
        )
        return self.last_status


def _reason_message(reason: str) -> str:
    return REASON_MESSAGES.get(reason, reason.replace("-", " ") if reason else "동기화 실패")


def _fx_rate(settings: AppSettings, fx: FxSnapshot | None) -> float | None:
    if settings.fx_auto_enabled and fx and fx.rate is not None:
        if fx.is_usable(settings.fx_max_stale_seconds):
            return fx.rate
        return None
    if settings.usdt_rate > 0:
        return settings.usdt_rate
    return fx.rate if fx and fx.rate else None
