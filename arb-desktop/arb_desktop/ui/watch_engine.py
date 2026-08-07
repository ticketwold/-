from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import OddsOnlyMetrics, compute_odds_only_metrics, odds_in_range
from arb_desktop.market_data.bithumb_fx import FxSnapshot, FxStatus
from arb_desktop.ui.settings_store import AppSettings


class WatchState(str, Enum):
    IDLE = "IDLE"
    CONNECTING = "CONNECTING"
    TARGET_WAIT = "TARGET WAIT"
    STABILIZING = "STABILIZING"
    READY = "READY"
    INPUTTING = "INPUTTING"
    VERIFYING = "VERIFYING"
    BETTING = "BETTING"
    SUCCESS = "SUCCESS"
    ABORTED = "ABORTED"


@dataclass
class WatchMetrics:
    bti_odds: float | None = None
    bc_odds: float | None = None
    bti_stake_krw: float = 0.0
    bc_stake_usdt: float = 0.0
    bc_stake_krw: float = 0.0
    total_stake_krw: float = 0.0
    profit_x10_krw: float = 0.0
    profit_bc_krw: float = 0.0
    bti_return_krw: float = 0.0
    bc_return_krw: float = 0.0
    min_guaranteed_profit_krw: float = 0.0
    profit_rate_x10: float = 0.0
    profit_rate_bc: float = 0.0
    min_guaranteed_profit_pct: float = 0.0
    current_profit_rate: float = 0.0
    target_profit_pct: float = 0.0
    target_delta_pct: float = 0.0
    fx_rate: float | None = None
    fx_status: str = ""
    fx_updated_at: str = ""
    message: str = ""


def _metrics_from_odds_only(calc: OddsOnlyMetrics, fx: FxSnapshot | None) -> WatchMetrics:
    return WatchMetrics(
        bti_odds=calc.bti_odds,
        bc_odds=calc.bc_odds,
        bti_stake_krw=calc.bti_stake_krw,
        bc_stake_usdt=calc.bc_stake_usdt,
        bc_stake_krw=calc.bc_stake_krw,
        total_stake_krw=calc.total_stake_krw,
        profit_x10_krw=calc.profit_x10_krw,
        profit_bc_krw=calc.profit_bc_krw,
        bti_return_krw=calc.bti_stake_krw * calc.bti_odds,
        bc_return_krw=calc.bc_stake_usdt * (fx.rate if fx and fx.rate else 0) * calc.bc_odds,
        min_guaranteed_profit_krw=calc.min_profit_krw,
        profit_rate_x10=calc.profit_rate_x10,
        profit_rate_bc=calc.profit_rate_bc,
        min_guaranteed_profit_pct=calc.current_profit_rate,
        current_profit_rate=calc.current_profit_rate,
        target_profit_pct=calc.target_profit_pct,
        target_delta_pct=calc.target_delta_pct,
        fx_rate=fx.rate if fx else None,
        fx_status=fx.status.value if fx else "",
        fx_updated_at=_format_ts(fx.updated_at) if fx and fx.updated_at else "",
    )


def _format_ts(ts: float) -> str:
    from datetime import datetime

    return datetime.fromtimestamp(ts).strftime("%H:%M:%S")


@dataclass
class WatchEngine:
    state: WatchState = WatchState.IDLE
    metrics: WatchMetrics = field(default_factory=WatchMetrics)
    _stable_since: float | None = None
    _stable_count: int = 0
    _last_odds_key: str = ""
    _watching: bool = False
    _user_confirmed: bool = False

    def start_watch(self, *, user_confirmed: bool = False) -> None:
        self._watching = True
        self._user_confirmed = user_confirmed
        if self.state == WatchState.IDLE:
            self.state = WatchState.TARGET_WAIT

    def stop_watch(self) -> None:
        self._watching = False
        self.state = WatchState.IDLE
        self._reset_stabilize()

    def set_connecting(self) -> None:
        if not self._watching:
            self.state = WatchState.CONNECTING

    def set_idle(self) -> None:
        if not self._watching:
            self.state = WatchState.IDLE

    def compute_live_metrics(
        self,
        *,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        settings: AppSettings,
        fx: FxSnapshot | None,
    ) -> WatchMetrics:
        self.metrics.target_profit_pct = settings.target_profit_pct
        usdt_rate = _resolve_fx_rate(settings, fx)
        if usdt_rate is None:
            self.metrics.fx_rate = fx.rate if fx else None
            self.metrics.fx_status = fx.status.value if fx else FxStatus.LOADING.value
            self.metrics.fx_updated_at = _format_ts(fx.updated_at) if fx and fx.updated_at else ""
            self.metrics.message = fx.message if fx else "fx-loading"
            return self.metrics

        err = _validate_odds_only_slips(bc, bti)
        if err:
            self.metrics.message = err
            self.metrics.fx_rate = usdt_rate
            if fx:
                self.metrics.fx_status = fx.status.value
                self.metrics.fx_updated_at = _format_ts(fx.updated_at)
            return self.metrics

        bc_item = bc.first
        bti_item = bti.first
        assert bc_item and bti_item
        calc = compute_odds_only_metrics(
            bti_odds=float(bti_item.odds or 0),
            bc_odds=float(bc_item.odds or 0),
            bti_stake_krw=settings.bti_stake_krw,
            usdt_rate=usdt_rate,
            round_unit_krw=settings.round_unit_krw,
            round_unit_usdt=settings.round_unit_usdt,
            target_profit_pct=settings.target_profit_pct,
        )
        if not calc:
            self.metrics.message = "bc-odds-missing"
            return self.metrics

        self.metrics = _metrics_from_odds_only(calc, fx)
        self.metrics.message = ""
        return self.metrics

    def tick(
        self,
        *,
        bridge_connected: bool,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        settings: AppSettings,
        fx: FxSnapshot | None,
        user_confirmed: bool = False,
    ) -> tuple[WatchState, WatchMetrics, str | None]:
        self._user_confirmed = user_confirmed
        self.metrics = self.compute_live_metrics(bc=bc, bti=bti, settings=settings, fx=fx)

        if not self._watching:
            return self.state, self.metrics, None

        if not bridge_connected:
            self.state = WatchState.ABORTED
            self.metrics.message = "bridge-disconnected"
            return self.state, self.metrics, "bridge-disconnected"

        fx_err = _validate_fx(fx, settings)
        if fx_err:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = fx_err
            return self.state, self.metrics, fx_err

        slip_err = _validate_odds_only_slips(bc, bti)
        if slip_err:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = slip_err
            return self.state, self.metrics, slip_err

        if not user_confirmed:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = "반대 선택 미확인"
            return self.state, self.metrics, "confirm-required"

        bc_item = bc.first
        bti_item = bti.first
        assert bc_item and bti_item

        usdt_rate = _resolve_fx_rate(settings, fx)
        assert usdt_rate is not None

        calc = compute_odds_only_metrics(
            bti_odds=float(bti_item.odds or 0),
            bc_odds=float(bc_item.odds or 0),
            bti_stake_krw=settings.bti_stake_krw,
            usdt_rate=usdt_rate,
            round_unit_krw=settings.round_unit_krw,
            round_unit_usdt=settings.round_unit_usdt,
            target_profit_pct=settings.target_profit_pct,
        )
        if not calc:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = "bc-odds-missing"
            return self.state, self.metrics, "bc-odds-missing"

        self.metrics = _metrics_from_odds_only(calc, fx)

        odds_key = f"{bc_item.odds:.4f}|{bti_item.odds:.4f}|{usdt_rate:.2f}|{calc.bc_stake_usdt:.2f}"
        if odds_key != self._last_odds_key:
            self._last_odds_key = odds_key
            self._stable_since = None
            self._stable_count = 0
            if self.state == WatchState.READY:
                self.state = WatchState.TARGET_WAIT

        current_rate = calc.current_profit_rate
        if current_rate < settings.target_profit_pct:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = f"below-target ({current_rate:.2f}%)"
            return self.state, self.metrics, "below-target"

        self._stable_count += 1
        now = time.monotonic()
        if self._stable_since is None:
            self._stable_since = now

        elapsed = now - (self._stable_since or now)
        if (
            self._stable_count >= settings.stable_count_required
            and elapsed >= settings.stabilize_seconds
        ):
            self.state = WatchState.READY
            self.metrics.message = "target-reached — READY (드라이런)"
            return self.state, self.metrics, "ready"

        self.state = WatchState.STABILIZING
        self.metrics.message = f"stabilizing ({self._stable_count}/{settings.stable_count_required}, {elapsed:.1f}s)"
        return self.state, self.metrics, "stabilizing"

    def _reset_stabilize(self) -> None:
        self._stable_since = None
        self._stable_count = 0


def _resolve_fx_rate(settings: AppSettings, fx: FxSnapshot | None) -> float | None:
    if settings.fx_auto_enabled and fx and fx.rate is not None:
        if fx.is_usable(settings.fx_max_stale_seconds):
            return fx.rate
        return None
    if settings.usdt_rate > 0:
        return settings.usdt_rate
    return fx.rate if fx and fx.rate else None


def _validate_fx(fx: FxSnapshot | None, settings: AppSettings) -> str | None:
    if not settings.fx_auto_enabled:
        if settings.usdt_rate <= 0:
            return "fx-api-error"
        return None
    if fx is None or fx.status == FxStatus.LOADING:
        return FxStatus.LOADING.value
    if fx.rate is None:
        return FxStatus.ERROR.value
    if not fx.is_usable(settings.fx_max_stale_seconds):
        return FxStatus.STALE.value
    if fx.status == FxStatus.DELAYED:
        return None
    if fx.status == FxStatus.LIVE:
        return None
    if fx.status == FxStatus.ERROR:
        return FxStatus.ERROR.value
    return None


def _validate_odds_only_slips(bc: BetSlipReadResult, bti: BetSlipReadResult) -> str | None:
    if bc.empty or not bc.first:
        return "bc-odds-missing"
    if bti.empty or not bti.first:
        return "x10-odds-missing"
    if len(bc.items) != 1 or len(bti.items) != 1:
        return "slip-count-not-one"
    if bc.first.status == SlipStatus.SUSPENDED or bti.first.status == SlipStatus.SUSPENDED:
        return "suspended"
    if bc.first.status != SlipStatus.ACTIVE or bti.first.status != SlipStatus.ACTIVE:
        return "suspended"
    if not odds_in_range(bc.first.odds):
        return "bc-odds-missing"
    if not odds_in_range(bti.first.odds):
        return "x10-odds-missing"
    return None
