from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum

from arb_desktop.betslip.matcher import calculate_arbitrage, check_slip_pair
from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
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
    total_stake_krw: float = 0.0
    bti_return_krw: float = 0.0
    bc_return_krw: float = 0.0
    min_guaranteed_profit_krw: float = 0.0
    min_guaranteed_profit_pct: float = 0.0
    target_profit_pct: float = 0.0
    message: str = ""


@dataclass
class WatchEngine:
    state: WatchState = WatchState.IDLE
    metrics: WatchMetrics = field(default_factory=WatchMetrics)
    _stable_since: float | None = None
    _stable_count: int = 0
    _last_odds_key: str = ""
    _watching: bool = False

    def start_watch(self) -> None:
        self._watching = True
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

    def tick(
        self,
        *,
        bridge_connected: bool,
        bc: BetSlipReadResult,
        bti: BetSlipReadResult,
        settings: AppSettings,
    ) -> tuple[WatchState, WatchMetrics, str | None]:
        self.metrics.target_profit_pct = settings.target_profit_pct

        if not self._watching:
            self.metrics.message = ""
            return self.state, self.metrics, None

        if not bridge_connected:
            self.state = WatchState.ABORTED
            self.metrics.message = "Bridge 연결 끊김"
            return self.state, self.metrics, "bridge-disconnected"

        err = self._validate_slips(bc, bti)
        if err:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = err
            return self.state, self.metrics, err

        match = check_slip_pair(bc, bti)
        if not match.safe_to_calculate:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = match.reason or "매칭 실패"
            return self.state, self.metrics, match.reason

        bc_item = bc.first
        bti_item = bti.first
        assert bc_item and bti_item

        arb = calculate_arbitrage(
            bc_item,
            bti_item,
            bti_base_stake_krw=settings.bti_stake_krw,
            usdt_rate=settings.usdt_rate,
        )
        if not arb or arb.profit_rate is None:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = "금액 계산 오류"
            return self.state, self.metrics, "calc-error"

        bc_stake = _round_usdt(arb.stake_a or 0.0, settings.round_unit_usdt)
        bti_stake = _round_krw(arb.stake_b or settings.bti_stake_krw, settings.round_unit_krw)
        bc_return_krw = bc_stake * settings.usdt_rate * (arb.odds_a or 0.0)
        bti_return_krw = bti_stake * (arb.odds_b or 0.0)
        total_stake_krw = bti_stake + bc_stake * settings.usdt_rate
        min_return = min(bc_return_krw, bti_return_krw)
        min_profit = min_return - total_stake_krw
        min_profit_pct = (min_profit / total_stake_krw * 100) if total_stake_krw > 0 else 0.0

        self.metrics = WatchMetrics(
            bti_odds=bti_item.odds,
            bc_odds=bc_item.odds,
            bti_stake_krw=bti_stake,
            bc_stake_usdt=bc_stake,
            total_stake_krw=total_stake_krw,
            bti_return_krw=bti_return_krw,
            bc_return_krw=bc_return_krw,
            min_guaranteed_profit_krw=min_profit,
            min_guaranteed_profit_pct=min_profit_pct,
            target_profit_pct=settings.target_profit_pct,
            message="",
        )

        odds_key = f"{bc_item.odds:.4f}|{bti_item.odds:.4f}"
        if odds_key != self._last_odds_key:
            self._last_odds_key = odds_key
            self._stable_since = None
            self._stable_count = 0
            if self.state == WatchState.READY:
                self.state = WatchState.TARGET_WAIT

        if min_profit_pct < settings.target_profit_pct:
            self.state = WatchState.TARGET_WAIT
            self._reset_stabilize()
            self.metrics.message = f"목표 수익률 미달 ({min_profit_pct:.2f}%)"
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
            self.metrics.message = "조건 충족 — READY (드라이런)"
            return self.state, self.metrics, None

        self.state = WatchState.STABILIZING
        self.metrics.message = f"안정화 중 ({self._stable_count}/{settings.stable_count_required}, {elapsed:.1f}s)"
        return self.state, self.metrics, None

    def _validate_slips(self, bc: BetSlipReadResult, bti: BetSlipReadResult) -> str | None:
        if bc.empty or not bc.first:
            return "BC BetSlip 없음"
        if bti.empty or not bti.first:
            return "x10 BetSlip 없음"
        if len(bc.items) > 1 or len(bti.items) > 1:
            return "카트 항목이 2개 이상"
        if bc.first.status == SlipStatus.SUSPENDED or bti.first.status == SlipStatus.SUSPENDED:
            return "SUSPENDED"
        if bc.first.status != SlipStatus.ACTIVE or bti.first.status != SlipStatus.ACTIVE:
            return "BetSlip 비활성"
        if bc.first.odds is None or bti.first.odds is None:
            return "배당 누락"
        return None

    def _reset_stabilize(self) -> None:
        self._stable_since = None
        self._stable_count = 0


def _round_krw(value: float, unit: int) -> float:
    if unit <= 0:
        return round(value)
    return round(value / unit) * unit


def _round_usdt(value: float, unit: float) -> float:
    if unit <= 0:
        return round(value, 2)
    return round(value / unit) * unit
