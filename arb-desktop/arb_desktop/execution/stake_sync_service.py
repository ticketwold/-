from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import OddsOnlyMetrics, compute_odds_only_metrics, odds_in_range
from arb_desktop.bridge.command_bus import CommandResult
from arb_desktop.market_data.bithumb_fx import FxSnapshot
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.site_status import both_sites_active, slip_status_from_read


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


@dataclass
class StakeSyncService:
    """BC stake 상시 자동동기화 — watch_enabled와 독립."""

    last_status: StakeSyncStatus = None  # type: ignore[assignment]

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
        if not write.ok:
            reason = write.reason or write.error or "stake-sync-failed"
            state = (
                StakeSyncState.INPUT_NOT_FOUND
                if "not-found" in reason
                else StakeSyncState.FAILED
            )
            self.last_status = StakeSyncStatus(
                state=state,
                calculated_usdt=target,
                actual_usdt=write.actual,
                message=reason.upper().replace("-", " "),
            )
            return self.last_status

        read: CommandResult = await server.send_command("bc", "read_bc_stake")
        actual = read.actual if read.ok else write.actual
        ok = actual is not None and abs(actual - target) <= 0.15
        self.last_status = StakeSyncStatus(
            state=StakeSyncState.OK if ok else StakeSyncState.FAILED,
            calculated_usdt=target,
            actual_usdt=actual,
            message="동기화 완료" if ok else "STAKE SYNC FAILED",
        )
        return self.last_status


def _fx_rate(settings: AppSettings, fx: FxSnapshot | None) -> float | None:
    if settings.fx_auto_enabled and fx and fx.rate is not None:
        if fx.is_usable(settings.fx_max_stale_seconds):
            return fx.rate
        return None
    if settings.usdt_rate > 0:
        return settings.usdt_rate
    return fx.rate if fx and fx.rate else None
