from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.betslip.odds_only_calc import OddsOnlyMetrics, compute_odds_only_metrics, odds_in_range
from arb_desktop.market_data.bithumb_fx import FxSnapshot, FxStatus
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.site_status import (
    SiteStatusDebouncer,
    both_sites_active,
    site_label,
    slip_status_from_read,
    wait_reason_for_site,
)


class WatchState(str, Enum):
    IDLE = "IDLE"
    CONNECTING = "CONNECTING"
    TARGET_WAIT = "TARGET WAIT"
    STABILIZING = "STABILIZING"
    READY = "READY"
    AUTO_BET_WAIT = "AUTO BET WAIT"
    PREPARING = "PREPARING"
    DISPATCHING = "DISPATCHING"
    VERIFYING_RESULT = "VERIFYING RESULT"
    SUCCESS = "SUCCESS"
    PARTIAL_BET = "PARTIAL BET"
    FAILED = "FAILED"
    INPUTTING = "INPUTTING"
    VERIFYING = "VERIFYING"
    BETTING = "BETTING"
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
    bc_site_label: str = "카트 없음"
    x10_site_label: str = "카트 없음"
    dispatch_note: str = ""
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
    _site_debounce: SiteStatusDebouncer = field(default_factory=SiteStatusDebouncer)
    _was_auto_bet_wait: bool = False
    _dispatch_armed: bool = False

    def start_watch(self, *, user_confirmed: bool = False) -> None:
        self._watching = True
        self._user_confirmed = user_confirmed
        self._dispatch_armed = False
        if self.state in {WatchState.IDLE, WatchState.ABORTED}:
            self.state = WatchState.TARGET_WAIT

    def stop_watch(self) -> None:
        self._watching = False
        self.state = WatchState.IDLE
        self._was_auto_bet_wait = False
        self._dispatch_armed = False
        self._reset_stabilize()
        self._site_debounce.reset()

    def set_connecting(self) -> None:
        if not self._watching:
            self.state = WatchState.CONNECTING

    def set_idle(self) -> None:
        if not self._watching:
            self.state = WatchState.IDLE

    def mark_dispatch_complete(self, *, partial: bool = False, success: bool = False) -> None:
        self._dispatch_armed = False
        self._reset_stabilize()
        if partial:
            self.state = WatchState.PARTIAL_BET
            self.metrics.message = "PARTIAL BET — MANUAL ACTION REQUIRED"
        elif success:
            self.state = WatchState.SUCCESS
        else:
            self.state = WatchState.FAILED
        if self._watching and self.state not in {WatchState.PARTIAL_BET}:
            self.state = WatchState.TARGET_WAIT

    def set_dispatch_state(self, state: WatchState, message: str = "") -> None:
        self.state = state
        if message:
            self.metrics.message = message

    def update_site_labels(self, bc: BetSlipReadResult, bti: BetSlipReadResult) -> tuple[SlipStatus, SlipStatus]:
        bc_raw = slip_status_from_read(bc)
        x10_raw = slip_status_from_read(bti)
        bc_status = self._site_debounce.update("bc", bc_raw)
        x10_status = self._site_debounce.update("x10", x10_raw)
        self.metrics.bc_site_label = site_label(bc_status)
        self.metrics.x10_site_label = site_label(x10_status)
        return bc_status, x10_status

    def compute_live_metrics(
        self,
        *,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        settings: AppSettings,
        fx: FxSnapshot | None,
    ) -> WatchMetrics:
        self.metrics.target_profit_pct = settings.target_profit_pct
        self.update_site_labels(bc, bti)

        usdt_rate = _resolve_fx_rate(settings, fx)
        if usdt_rate is None:
            self.metrics.fx_rate = fx.rate if fx else None
            self.metrics.fx_status = fx.status.value if fx else FxStatus.LOADING.value
            self.metrics.fx_updated_at = _format_ts(fx.updated_at) if fx and fx.updated_at else ""
            self.metrics.message = fx.message if fx else "fx-loading"
            return self.metrics

        if not both_sites_active(*self.update_site_labels(bc, bti)):
            self.metrics.fx_rate = usdt_rate
            if fx:
                self.metrics.fx_status = fx.status.value
                self.metrics.fx_updated_at = _format_ts(fx.updated_at)
            return self.metrics

        bc_item = bc.first
        bti_item = bti.first
        if not bc_item or not bti_item:
            return self.metrics

        calc = compute_odds_only_metrics(
            bti_odds=float(bti_item.odds or 0),
            bc_odds=float(bc_item.odds or 0),
            bti_stake_krw=settings.bti_stake_krw,
            usdt_rate=usdt_rate,
            round_unit_krw=settings.round_unit_krw,
            round_unit_usdt=settings.round_unit_usdt,
            target_profit_pct=settings.target_profit_pct,
        )
        if calc:
            merged = _metrics_from_odds_only(calc, fx)
            merged.bc_site_label = self.metrics.bc_site_label
            merged.x10_site_label = self.metrics.x10_site_label
            merged.dispatch_note = self.metrics.dispatch_note
            self.metrics = merged
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
        bc_status, x10_status = self.update_site_labels(bc, bti)
        self.metrics = self.compute_live_metrics(bc=bc, bti=bti, settings=settings, fx=fx)

        if not self._watching:
            return self.state, self.metrics, None

        if self.state in {WatchState.PREPARING, WatchState.DISPATCHING, WatchState.VERIFYING_RESULT}:
            return self.state, self.metrics, None

        if self.state == WatchState.PARTIAL_BET:
            return self.state, self.metrics, "partial-bet-manual"

        if not bridge_connected:
            self._enter_auto_bet_wait("Bridge 재연결 대기", "bridge-disconnected")
            return self.state, self.metrics, "bridge-disconnected"

        fx_err = _validate_fx(fx, settings)
        if fx_err:
            self._enter_auto_bet_wait("환율 갱신 대기", fx_err)
            return self.state, self.metrics, fx_err

        wait_reason = _collect_site_wait_reason(bc_status, x10_status)
        if wait_reason and settings.bet_close_auto_wait:
            self._enter_auto_bet_wait(wait_reason, wait_reason)
            return self.state, self.metrics, "auto-bet-wait"

        if self._was_auto_bet_wait and settings.auto_resume_on_recovery:
            self._was_auto_bet_wait = False
            self._reset_stabilize()
            self.state = WatchState.TARGET_WAIT
            self.metrics.message = "양쪽 ACTIVE 복구 — 감시 재개"

        if not user_confirmed:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = "반대 선택 미확인"
            return self.state, self.metrics, "confirm-required"

        slip_err = _validate_active_slips(bc, bti)
        if slip_err:
            self._enter_auto_bet_wait(slip_err, slip_err)
            return self.state, self.metrics, slip_err

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
            self._enter_auto_bet_wait("배당 대기", "bc-odds-missing")
            return self.state, self.metrics, "bc-odds-missing"

        self.metrics = _metrics_from_odds_only(calc, fx)
        self.metrics.bc_site_label = site_label(bc_status)
        self.metrics.x10_site_label = site_label(x10_status)

        odds_key = f"{bc_item.odds:.4f}|{bti_item.odds:.4f}|{usdt_rate:.2f}|{calc.bc_stake_usdt:.2f}"
        if odds_key != self._last_odds_key:
            self._last_odds_key = odds_key
            self._reset_stabilize()
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
            self.metrics.message = "target-reached — READY"
            self.metrics.dispatch_note = (
                "병렬 실행 — 체결 시점은 사이트 응답 속도에 따라 다를 수 있음"
            )
            return self.state, self.metrics, "ready"

        self.state = WatchState.STABILIZING
        self.metrics.message = f"stabilizing ({self._stable_count}/{settings.stable_count_required}, {elapsed:.1f}s)"
        return self.state, self.metrics, "stabilizing"

    def consume_ready_for_dispatch(self) -> bool:
        if self.state != WatchState.READY or self._dispatch_armed:
            return False
        self._dispatch_armed = True
        return True

    def _enter_auto_bet_wait(self, message: str, err_key: str) -> None:
        self._was_auto_bet_wait = True
        self.state = WatchState.AUTO_BET_WAIT
        self._reset_stabilize()
        self.metrics.message = message

    def _reset_stabilize(self) -> None:
        self._stable_since = None
        self._stable_count = 0


def _collect_site_wait_reason(bc_status: SlipStatus, x10_status: SlipStatus) -> str | None:
    for site, status in (("bti", x10_status), ("bc", bc_status)):
        reason = wait_reason_for_site(site, status)
        if reason:
            return reason
    if bc_status == SlipStatus.EMPTY and x10_status == SlipStatus.EMPTY:
        return "양쪽 배당 대기"
    return None


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
    return None


def _validate_active_slips(bc: BetSlipReadResult, bti: BetSlipReadResult) -> str | None:
    if bc.empty or not bc.first:
        return "BC.Game 카트 없음"
    if bti.empty or not bti.first:
        return "텐텐벳 카트 없음"
    if len(bc.items) != 1 or len(bti.items) != 1:
        return "카트 재확인 중"
    if slip_status_from_read(bc) != SlipStatus.ACTIVE:
        return wait_reason_for_site("bc", slip_status_from_read(bc)) or "BC.Game 배팅 닫힘"
    if slip_status_from_read(bti) != SlipStatus.ACTIVE:
        return wait_reason_for_site("bti", slip_status_from_read(bti)) or "텐텐벳 배팅 닫힘"
    if not odds_in_range(bc.first.odds):
        return "BC.Game 배당 없음"
    if not odds_in_range(bti.first.odds):
        return "텐텐벳 배당 없음"
    return None
