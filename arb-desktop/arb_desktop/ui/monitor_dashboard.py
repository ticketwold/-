from __future__ import annotations

from datetime import datetime

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import QFrame, QGridLayout, QHBoxLayout, QLabel, QProgressBar, QVBoxLayout, QWidget

from arb_desktop.ui.widgets.kpi import ProfitKpi
from arb_desktop.ui.widgets.odds_card import SiteOddsCard
from arb_desktop.ui.widgets.stake_sync_card import StakeSyncCard
from arb_desktop.ui.watch_engine import WatchMetrics


class TradingHeader(QFrame):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("TradingHeader")
        row = QHBoxLayout(self)
        row.setContentsMargins(4, 0, 4, 0)

        self.lbl_brand = QLabel("ARB DESKTOP")
        self.lbl_brand.setProperty("class", "brand")

        chips = QHBoxLayout()
        chips.setSpacing(12)
        self.lbl_bridge = QLabel("● Bridge")
        self.lbl_x10 = QLabel("● X10")
        self.lbl_bc = QLabel("● BC")
        self.lbl_fx = QLabel("● Bithumb FX")
        for lbl in (self.lbl_bridge, self.lbl_x10, self.lbl_bc, self.lbl_fx):
            lbl.setProperty("class", "conn-chip")
            chips.addWidget(lbl)

        self.lbl_clock = QLabel("")
        self.lbl_clock.setProperty("class", "muted")
        self._clock = QTimer(self)
        self._clock.setInterval(1000)
        self._clock.timeout.connect(self._tick)
        self._clock.start()
        self._tick()

        row.addWidget(self.lbl_brand)
        row.addSpacing(24)
        row.addLayout(chips)
        row.addStretch()
        row.addWidget(self.lbl_clock)

        fail_row = QHBoxLayout()
        fail_row.setSpacing(12)
        self.lbl_x10_fail = QLabel("")
        self.lbl_bc_fail = QLabel("")
        for lbl in (self.lbl_x10_fail, self.lbl_bc_fail):
            lbl.setProperty("class", "mono")
            lbl.setWordWrap(True)
            lbl.hide()
            fail_row.addWidget(lbl, 1)
        self._fail_layout = fail_row

    def fail_layout(self) -> QHBoxLayout:
        return self._fail_layout

    def update_pipeline_failures(self, payload: dict | None) -> None:
        self._set_fail_label(self.lbl_x10_fail, "X10", payload.get("x10") if payload else None)
        self._set_fail_label(self.lbl_bc_fail, "BC", payload.get("bc") if payload else None)

    def _set_fail_label(self, lbl: QLabel, site: str, data: dict | None) -> None:
        if not data:
            lbl.hide()
            return
        fail = data.get("first_failure") or ""
        if fail:
            lbl.setText(f"FAIL {site}\n{fail}")
            lbl.setProperty("class", "status-bad")
            lbl.show()
        elif data.get("all_pass") == "yes":
            lbl.setText(f"PASS {site}")
            lbl.setProperty("class", "status-ok")
            lbl.show()
        else:
            lbl.hide()
        lbl.style().unpolish(lbl)
        lbl.style().polish(lbl)

    def _tick(self) -> None:
        self.lbl_clock.setText(datetime.now().strftime("%H:%M:%S"))

    def update_connections(self, m: WatchMetrics, *, bridge: str = "", fx_text: str = "") -> None:
        self._set_chip(self.lbl_bridge, "Bridge", bridge or ("CONNECTED" if m.bridge_connected else "WAIT"))
        self._set_chip(self.lbl_x10, "X10", m.x10_site_label)
        self._set_chip(self.lbl_bc, "BC", m.bc_site_label)
        fx = fx_text or (f"{m.fx_rate:,.0f}" if m.fx_rate else "—")
        self._set_chip(self.lbl_fx, "Bithumb FX", fx)

    def _set_chip(self, lbl: QLabel, name: str, value: str) -> None:
        ok = value in {"CONNECTED", "ACTIVE", "OK"} or (name == "Bithumb FX" and value not in {"—", "WAIT"})
        lbl.setText(f"● {name}")
        lbl.setProperty("class", "conn-chip on" if ok else "conn-chip")
        lbl.setToolTip(value)
        lbl.style().unpolish(lbl)
        lbl.style().polish(lbl)


class CalcSummaryCard(QFrame):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "Card")
        grid = QGridLayout(self)
        grid.setHorizontalSpacing(20)
        grid.setVerticalSpacing(8)
        self._fields: dict[str, QLabel] = {}
        labels = [
            ("total", "총 배팅금"),
            ("return", "예상 환급"),
            ("profit_x10", "X10 적중 수익"),
            ("profit_bc", "BC 적중 수익"),
            ("min_profit", "최저 보장수익"),
            ("rate", "현재 수익률"),
        ]
        for i, (key, title) in enumerate(labels):
            t = QLabel(title)
            t.setProperty("class", "muted")
            v = QLabel("—")
            v.setProperty("class", "calc-value")
            grid.addWidget(t, i // 2, (i % 2) * 2)
            grid.addWidget(v, i // 2, (i % 2) * 2 + 1)
            self._fields[key] = v

    def update_metrics(self, m: WatchMetrics) -> None:
        if not m.total_stake_krw:
            for v in self._fields.values():
                v.setText("—")
            return
        self._fields["total"].setText(f"{m.total_stake_krw:,.0f} KRW")
        ret = max(m.bti_return_krw, m.bc_return_krw)
        self._fields["return"].setText(f"{ret:,.0f} KRW")
        self._fields["profit_x10"].setText(f"{m.profit_x10_krw:,.0f} KRW")
        self._fields["profit_bc"].setText(f"{m.profit_bc_krw:,.0f} KRW")
        self._fields["min_profit"].setText(f"{m.min_guaranteed_profit_krw:,.0f} KRW")
        sign = "+" if m.current_profit_rate >= 0 else ""
        self._fields["rate"].setText(f"{sign}{m.current_profit_rate:.2f}%")


class CompactTicker(QFrame):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "ticker-bar")
        self.lbl = QLabel("—")
        self.lbl.setProperty("class", "ticker-text")
        self.lbl.setWordWrap(True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        layout.addWidget(self.lbl)
        self._lines: list[str] = []

    def push(self, line: str) -> None:
        self._lines.insert(0, line)
        self._lines = self._lines[:6]
        self.lbl.setText("\n".join(self._lines))

    def update_from_metrics(self, m: WatchMetrics, *, state: str = "") -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        if m.bti_odds and m.bti_odds_changed_at:
            arrow = "↑" if m.bti_odds_dir > 0 else "↓" if m.bti_odds_dir < 0 else ""
            self.push(f"{ts} X10 {m.bti_odds:.2f} {arrow}".strip())
        if m.bc_odds and m.bc_odds_changed_at:
            arrow = "↑" if m.bc_odds_dir > 0 else "↓" if m.bc_odds_dir < 0 else ""
            stake = f" · BC {m.bc_stake_usdt:.1f}" if m.bc_stake_usdt else ""
            self.push(f"{ts} BC {m.bc_odds:.2f} {arrow}{stake}".strip())
        if state == "READY" and m.total_stake_krw:
            self.push(f"{ts} ENGINE +{m.current_profit_rate:.2f}%")


class StatusBanner(QFrame):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("StatusBanner")
        self.hide()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 16, 20, 16)
        self.lbl_title = QLabel("")
        self.lbl_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_sub = QLabel("")
        self.lbl_sub.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_sub.setWordWrap(True)
        layout.addWidget(self.lbl_title)
        layout.addWidget(self.lbl_sub)
        self._anim = QTimer(self)
        self._anim.setInterval(400)
        self._anim.timeout.connect(self._tick)
        self._base = ""

    def _tick(self) -> None:
        self.lbl_title.setText(self._base + "." * (int(datetime.now().timestamp()) % 4))

    def hide_banner(self) -> None:
        self._anim.stop()
        self.hide()

    def show_ready(self, rate: float) -> None:
        self._anim.stop()
        self.setProperty("banner", "ready")
        self.lbl_title.setText("READY")
        self.lbl_title.setProperty("class", "banner-ready-title")
        self.lbl_sub.setText(f"현재 수익률 +{rate:.2f}% · 병렬 배팅 준비 완료")
        self._apply()
        self.show()

    def show_dispatching(self, gap_ms: float = 0) -> None:
        self.setProperty("banner", "dispatching")
        self._base = "양쪽 배팅 전송 중"
        self.lbl_title.setProperty("class", "banner-dispatch-title")
        gap = f" · dispatch gap {gap_ms:.1f} ms" if gap_ms else ""
        self.lbl_sub.setText(f"병렬 전송 — 체결 시각은 사이트 응답에 따라 다를 수 있음{gap}")
        self._apply()
        self._anim.start()
        self.show()

    def show_partial(self, message: str = "") -> None:
        self._anim.stop()
        self.setProperty("banner", "partial")
        self.lbl_title.setText("일부 배팅 성공")
        self.lbl_title.setProperty("class", "banner-partial-title")
        self.lbl_sub.setText(message or "즉시 확인 필요 — 재실행 금지")
        self._apply()
        self.show()

    def _apply(self) -> None:
        self.style().unpolish(self)
        self.style().polish(self)
        for w in (self.lbl_title, self.lbl_sub):
            w.style().unpolish(w)
            w.style().polish(w)


class StabilizeBar(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.lbl = QLabel("배당 안정화")
        self.lbl.setProperty("class", "muted")
        self.bar = QProgressBar()
        self.bar.setRange(0, 100)
        self.bar.setTextVisible(True)
        layout.addWidget(self.lbl)
        layout.addWidget(self.bar)

    def update_progress(self, m: WatchMetrics) -> None:
        if not m.watch_enabled or m.engine_state not in {"STABILIZING", "READY", "TARGET WAIT"}:
            self.hide()
            return
        count_pct = min(100, int(100 * m.stable_count / max(m.stable_count_required, 1)))
        time_pct = min(100, int(100 * m.stabilize_elapsed / max(m.stabilize_seconds, 0.001)))
        pct = min(count_pct, time_pct) if m.engine_state == "STABILIZING" else 100
        self.bar.setValue(pct)
        self.bar.setFormat(
            f"{m.stable_count}/{m.stable_count_required} · {m.stabilize_elapsed:.1f}s / {m.stabilize_seconds:.1f}s"
        )
        self.show()


class MonitorDashboard(QWidget):
    """v1.6 trading dashboard."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("MonitorDashboard")
        root = QVBoxLayout(self)
        root.setSpacing(12)

        self.header = TradingHeader()
        root.addWidget(self.header)
        root.addLayout(self.header.fail_layout())

        self.status_banner = StatusBanner()
        root.addWidget(self.status_banner)

        self.profit_kpi = ProfitKpi()
        root.addWidget(self.profit_kpi)

        sites = QHBoxLayout()
        sites.setSpacing(12)
        self.card_x10 = SiteOddsCard("X10")
        self.card_bc = SiteOddsCard("BC.Game")
        sites.addWidget(self.card_x10)
        sites.addWidget(self.card_bc)
        root.addLayout(sites)

        mid = QHBoxLayout()
        mid.setSpacing(12)
        self.calc_card = CalcSummaryCard()
        self.stake_sync = StakeSyncCard()
        mid.addWidget(self.calc_card, 2)
        mid.addWidget(self.stake_sync, 1)
        root.addLayout(mid)

        self.stabilize_bar = StabilizeBar()
        root.addWidget(self.stabilize_bar)

        exec_row = QHBoxLayout()
        self.lbl_watch = QLabel("○ 자동감시 OFF")
        self.lbl_watch.setProperty("class", "watch-off")
        self.lbl_live_exec = QLabel("실제 배팅 실행 OFF")
        self.lbl_live_exec.setProperty("class", "watch-off")
        self.lbl_exec_state = QLabel("시세 감시 준비됨")
        self.lbl_exec_state.setProperty("class", "muted")
        self.lbl_block_reason = QLabel("")
        self.lbl_block_reason.setProperty("class", "status-bad")
        self.lbl_block_reason.setWordWrap(True)
        exec_row.addWidget(self.lbl_watch)
        exec_row.addWidget(self.lbl_live_exec)
        exec_row.addWidget(self.lbl_exec_state, 1)
        root.addLayout(exec_row)
        root.addWidget(self.lbl_block_reason)

        self.lbl_checklist = QLabel("")
        self.lbl_checklist.setProperty("class", "mono")
        self.lbl_checklist.setWordWrap(True)
        root.addWidget(self.lbl_checklist)

        self.ticker = CompactTicker()
        root.addWidget(self.ticker)

        self._last_ticker_key = ""

    def update_all(self, m: WatchMetrics, *, state: str = "", message: str = "") -> None:
        state = state or m.engine_state or "IDLE"
        self.header.update_connections(m)
        self.profit_kpi.update_metrics(m)

        self.card_x10.update_card(
            odds=m.bti_odds,
            display_odds=m.bti_display_odds,
            status_label=m.x10_site_label,
            direction=m.bti_odds_dir,
            changed_at=m.bti_odds_changed_at,
            stake_text=f"{m.bti_stake_krw:,.0f} KRW" if m.bti_stake_krw else "",
            status=m.x10_site_label,
        )
        bc_krw = f"≈ {m.bc_stake_krw:,.0f} KRW" if m.bc_stake_krw else ""
        stake = (
            f"{m.bc_stake_usdt:.1f} USDT\n{bc_krw}".strip()
            if m.bc_stake_usdt
            else (f"추천 {m.stake_sync_calculated_usdt:.1f} USDT" if m.stake_sync_calculated_usdt else "")
        )
        self.card_bc.update_card(
            odds=m.bc_odds,
            direction=m.bc_odds_dir,
            changed_at=m.bc_odds_changed_at,
            stake_text=stake,
            status=m.bc_site_label,
        )

        self.calc_card.update_metrics(m)
        self.stake_sync.update_sync(m)
        self.stabilize_bar.update_progress(m)

        if m.watch_enabled:
            self.lbl_watch.setText("● 자동감시 ON" if state != "IDLE" else "○ 자동감시 OFF")
            self.lbl_watch.setProperty("class", "watch-on" if state != "IDLE" else "watch-off")
        else:
            self.lbl_watch.setText("○ 자동감시 OFF")
            self.lbl_watch.setProperty("class", "watch-off")
        self.lbl_watch.style().unpolish(self.lbl_watch)
        self.lbl_watch.style().polish(self.lbl_watch)

        self.lbl_exec_state.setText(message or m.execution_message or m.message or _idle_label(m, state))

        live_on = m.live_execution_on
        self.lbl_live_exec.setText(f"실제 배팅 실행 {'ON' if live_on else 'OFF'}")
        self.lbl_live_exec.setProperty("class", "watch-on" if live_on else "watch-off")
        self.lbl_live_exec.style().unpolish(self.lbl_live_exec)
        self.lbl_live_exec.style().polish(self.lbl_live_exec)

        if m.watch_enabled and m.dispatch_block_reason and state not in {"READY", "DISPATCHING", "PREPARING"}:
            self.lbl_block_reason.setText(f"자동배팅 대기 — 사유: {m.dispatch_block_reason}")
            self.lbl_block_reason.show()
        elif state == "READY" and not live_on:
            self.lbl_block_reason.setText("READY — live_execution_disabled (실제 배팅 실행 OFF)")
            self.lbl_block_reason.show()
        elif state == "READY" and m.dry_run_on:
            self.lbl_block_reason.setText("READY — dry_run_enabled")
            self.lbl_block_reason.show()
        else:
            self.lbl_block_reason.hide()

        if m.exec_checklist:
            parts = [f"{k}: {v}" for k, v in m.exec_checklist.items()]
            self.lbl_checklist.setText(" | ".join(parts))
        else:
            self.lbl_checklist.setText("")

        self._update_banner(m, state, message)
        self._update_glow(m, state)

        key = f"{m.bti_odds}|{m.bc_odds}|{state}|{m.current_profit_rate}"
        if key != self._last_ticker_key:
            self.ticker.update_from_metrics(m, state=state)
            self._last_ticker_key = key

    def _update_banner(self, m: WatchMetrics, state: str, message: str) -> None:
        if state == "READY" and m.watch_enabled:
            self.status_banner.show_ready(m.current_profit_rate)
        elif state in {"PREPARING", "DISPATCHING", "VERIFYING RESULT"} or m.execution_phase in {
            "DISPATCH",
            "PREPARE",
            "VERIFY",
        }:
            self.status_banner.show_dispatching(m.dispatch_gap_ms)
        elif state == "PARTIAL BET" or m.execution_phase == "PARTIAL BET":
            self.status_banner.show_partial(message)
        else:
            self.status_banner.hide_banner()

    def update_pipeline_overlay(self, payload: dict | None) -> None:
        self.header.update_pipeline_failures(payload)

    def _update_glow(self, m: WatchMetrics, state: str) -> None:
        if state == "READY" and m.watch_enabled:
            glow = "ready"
        elif state in {"PARTIAL BET", "FAILED"}:
            glow = "alert"
        else:
            glow = "normal"
        self.setProperty("glow", glow)
        self.style().unpolish(self)
        self.style().polish(self)


def _idle_label(m: WatchMetrics, state: str) -> str:
    if not m.bridge_connected:
        return "연결 중..."
    if m.stake_sync_state == "OK":
        return "BC 금액 동기화 완료"
    if m.stake_sync_state == "SYNCING":
        return "BC 금액 동기화 중..."
    if state == "TARGET WAIT":
        return "목표 수익률 대기"
    if m.watch_enabled:
        return "실시간 감시 중"
    return "시세 감시 준비됨"
