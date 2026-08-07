from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import QFrame, QGridLayout, QGroupBox, QHBoxLayout, QLabel, QProgressBar, QVBoxLayout, QWidget

from arb_desktop.ui.icon_helper import icon
from arb_desktop.ui.modern_widgets import MiniStatCard, SiteCard, _status_kind, fade_in
from arb_desktop.ui.watch_engine import WatchMetrics


class StatusBanner(QFrame):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("StatusBanner")
        self.hide()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(4)
        self.lbl_rule_top = QLabel("━" * 28)
        self.lbl_rule_top.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_rule_top.setProperty("class", "banner-text")
        self.lbl_title = QLabel("")
        self.lbl_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_sub = QLabel("")
        self.lbl_sub.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_profit = QLabel("")
        self.lbl_profit.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_rule_bot = QLabel("━" * 28)
        self.lbl_rule_bot.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_rule_bot.setProperty("class", "banner-text")
        for w in (self.lbl_rule_top, self.lbl_title, self.lbl_sub, self.lbl_profit, self.lbl_rule_bot):
            layout.addWidget(w)
        self._anim_timer = QTimer(self)
        self._anim_timer.setInterval(400)
        self._anim_timer.timeout.connect(self._tick_anim)
        self._anim_dots = 0
        self._anim_base = ""
        self._visible = False

    def _tick_anim(self) -> None:
        self._anim_dots = (self._anim_dots + 1) % 4
        self.lbl_title.setText(f"{self._anim_base}{'.' * self._anim_dots}")

    def hide_banner(self) -> None:
        self._anim_timer.stop()
        self._visible = False
        self.hide()

    def show_ready(self, profit_text: str = "") -> None:
        self._anim_timer.stop()
        self.setProperty("banner", "ready")
        self.lbl_title.setText("READY")
        self.lbl_title.setProperty("class", "banner-ready-title")
        self.lbl_sub.setText("자동배팅 가능")
        self.lbl_sub.setProperty("class", "banner-text")
        self.lbl_profit.setText(profit_text)
        self.lbl_profit.setProperty("class", "banner-text")
        self._show_animated()

    def show_dispatching(self) -> None:
        self.setProperty("banner", "dispatching")
        self._anim_base = "양쪽 동시 배팅 중"
        self._anim_dots = 0
        self.lbl_title.setProperty("class", "banner-dispatch-title")
        self.lbl_sub.setText("병렬 실행 — 체결 시점은 사이트 응답 속도에 따라 다를 수 있음")
        self.lbl_profit.setText("")
        self._show_animated()
        self._anim_timer.start()

    def show_partial(self, message: str = "") -> None:
        self._anim_timer.stop()
        self.setProperty("banner", "partial")
        self.lbl_title.setText("부분 체결")
        self.lbl_title.setProperty("class", "banner-partial-title")
        self.lbl_sub.setText(message or "일부 배팅 성공 — 수동 확인 필요")
        self.lbl_profit.setText("")
        self._show_animated()

    def show_closed(self, message: str) -> None:
        self._anim_timer.stop()
        self.setProperty("banner", "closed")
        self.lbl_title.setText("자동배팅 대기")
        self.lbl_title.setProperty("class", "banner-closed-title")
        self.lbl_sub.setText(message)
        self.lbl_profit.setText("")
        self._show_animated()

    def _show_animated(self) -> None:
        was_hidden = not self._visible
        self._visible = True
        self.style().unpolish(self)
        self.style().polish(self)
        for w in (self.lbl_title, self.lbl_sub, self.lbl_profit):
            w.style().unpolish(w)
            w.style().polish(w)
        self.show()
        if was_hidden:
            fade_in(self)


class ProfitHeroPanel(QFrame):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "glass-card")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 28, 24, 28)
        layout.setSpacing(8)
        self.lbl_title = QLabel("현재 수익률")
        self.lbl_title.setProperty("class", "profit-hero-label")
        self.lbl_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_rate = QLabel("—")
        self.lbl_rate.setProperty("class", "profit-negative")
        self.lbl_rate.setAlignment(Qt.AlignmentFlag.AlignCenter)
        row = QHBoxLayout()
        row.setSpacing(24)
        self.lbl_target_pct = QLabel("목표 —")
        self.lbl_target_pct.setProperty("class", "card-subtitle")
        self.lbl_target_delta = QLabel("—")
        self.lbl_target_delta.setProperty("class", "target-miss")
        self.lbl_min_profit = QLabel("")
        self.lbl_min_profit.setProperty("class", "card-subtitle")
        row.addStretch()
        row.addWidget(self.lbl_target_pct)
        row.addWidget(self.lbl_target_delta)
        row.addWidget(self.lbl_min_profit)
        row.addStretch()
        layout.addWidget(self.lbl_title)
        layout.addWidget(self.lbl_rate)
        layout.addLayout(row)

    def update_metrics(self, m: WatchMetrics) -> None:
        if m.total_stake_krw:
            rate = m.current_profit_rate
            sign = "+" if rate >= 0 else ""
            self.lbl_rate.setText(f"{sign}{rate:.2f} %")
            css = "profit-positive" if rate >= m.target_profit_pct else "profit-negative"
            self.lbl_rate.setProperty("class", css)
            self.lbl_rate.style().unpolish(self.lbl_rate)
            self.lbl_rate.style().polish(self.lbl_rate)
            delta = m.target_delta_pct
            dsign = "+" if delta >= 0 else ""
            self.lbl_target_delta.setText(f"목표까지 {dsign}{delta:.2f}%p")
            dcss = "target-hit" if delta >= 0 else "target-miss"
            self.lbl_target_delta.setProperty("class", dcss)
            self.lbl_target_delta.style().unpolish(self.lbl_target_delta)
            self.lbl_target_delta.style().polish(self.lbl_target_delta)
            self.lbl_target_pct.setText(f"목표 {m.target_profit_pct:.2f}%")
            self.lbl_min_profit.setText(f"최저 보장 {m.min_guaranteed_profit_krw:,.0f} KRW")
        else:
            self.lbl_rate.setText("—")
            self.lbl_target_delta.setText("—")
            self.lbl_target_pct.setText("목표 —")
            self.lbl_min_profit.setText("")


class ReadinessChecklist(QGroupBox):
    CHECK_ITEMS = (
        ("bridge", "Bridge"),
        ("bc_active", "BC ACTIVE"),
        ("x10_active", "x10 ACTIVE"),
        ("target", "목표 수익률"),
        ("stabilized", "안정화"),
        ("ready", "READY"),
    )

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__("자동배팅 상태", parent)
        layout = QGridLayout(self)
        layout.setHorizontalSpacing(20)
        layout.setVerticalSpacing(8)
        self._labels: dict[str, QLabel] = {}
        for i, (key, text) in enumerate(self.CHECK_ITEMS):
            lbl = QLabel(f"⚪ {text}")
            lbl.setProperty("class", "check-pending")
            self._labels[key] = lbl
            layout.addWidget(lbl, i // 3, i % 3)

    def update_checks(self, m: WatchMetrics) -> None:
        if not m.watch_enabled:
            self.hide()
            return
        self.show()
        checks = {
            "bridge": m.bridge_connected,
            "bc_active": m.bc_site_label == "ACTIVE",
            "x10_active": m.x10_site_label == "ACTIVE",
            "stabilized": m.engine_state in {"READY", "STABILIZING"}
            and m.stable_count >= m.stable_count_required
            and m.stabilize_elapsed >= m.stabilize_seconds,
            "target": m.target_delta_pct >= 0 and m.total_stake_krw > 0,
            "ready": m.engine_state == "READY",
        }
        for key, text in self.CHECK_ITEMS:
            ok = checks[key]
            sym = "🟢" if ok else "⚪"
            lbl = self._labels[key]
            lbl.setText(f"{sym} {text}")
            lbl.setProperty("class", "check-ok" if ok else "check-pending")
            lbl.style().unpolish(lbl)
            lbl.style().polish(lbl)


class StabilizeBar(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.lbl = QLabel("배당 안정화")
        self.lbl.setProperty("class", "card-subtitle")
        self.bar = QProgressBar()
        self.bar.setRange(0, 100)
        self.bar.setTextVisible(True)
        layout.addWidget(self.lbl)
        layout.addWidget(self.bar)

    def update_progress(self, m: WatchMetrics) -> None:
        if not m.watch_enabled:
            self.hide()
            return
        if m.engine_state not in {"STABILIZING", "READY", "TARGET WAIT"} or not m.stable_count_required:
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
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("MonitorDashboard")
        root = QVBoxLayout(self)
        root.setSpacing(14)
        root.setContentsMargins(4, 4, 4, 4)

        self.status_banner = StatusBanner()
        root.addWidget(self.status_banner)

        top = QHBoxLayout()
        top.setSpacing(10)
        self.card_bridge = MiniStatCard("Bridge", icon_name="bridge")
        self.card_bc = MiniStatCard("BC.Game", icon_name="bc")
        self.card_x10 = MiniStatCard("텐텐벳", icon_name="x10")
        self.card_fx = MiniStatCard("환율", icon_name="fx")
        self.card_watch = MiniStatCard("자동감시", icon_name="watch")
        for c in (self.card_bridge, self.card_bc, self.card_x10, self.card_fx, self.card_watch):
            top.addWidget(c, 1)
        root.addLayout(top)

        self.profit_hero = ProfitHeroPanel()
        root.addWidget(self.profit_hero)

        sites = QHBoxLayout()
        sites.setSpacing(12)
        self.site_x10 = SiteCard("텐텐벳", accent="x10")
        self.site_bc = SiteCard("BC.Game", accent="bc")
        sites.addWidget(self.site_x10)
        sites.addWidget(self.site_bc)
        root.addLayout(sites)

        stakes = QHBoxLayout()
        stakes.setSpacing(8)
        self.lbl_x10_stake = QLabel("텐텐벳 —")
        self.lbl_bc_stake = QLabel("BC —")
        self.lbl_total_stake = QLabel("총 —")
        for lbl in (self.lbl_x10_stake, self.lbl_bc_stake, self.lbl_total_stake):
            lbl.setProperty("class", "stake-chip")
            stakes.addWidget(lbl)
        stakes.addStretch()
        root.addLayout(stakes)

        self.stabilize_bar = StabilizeBar()
        root.addWidget(self.stabilize_bar)
        self.checklist = ReadinessChecklist()
        root.addWidget(self.checklist)

        self._bridge_text = "WAITING"
        self._bc_tab = "—"
        self._x10_tab = "—"
        self._fx_text = "—"
        self._last_state = ""

    def update_connection(
        self,
        *,
        bridge: str,
        bc_tab: str,
        x10_tab: str,
        fx: str,
    ) -> None:
        self._bridge_text = bridge
        self._bc_tab = bc_tab
        self._x10_tab = x10_tab
        self._fx_text = fx

    def update_all(self, m: WatchMetrics, *, state: str = "", message: str = "") -> None:
        state = state or m.engine_state or "IDLE"
        self._update_top_cards(m, state)
        self.profit_hero.update_metrics(m)
        self.site_x10.update_from(
            selection=m.x10_display_selection,
            odds=m.bti_odds,
            status_label=m.x10_site_label,
            odds_dir=m.bti_odds_dir,
            odds_changed_at=m.bti_odds_changed_at,
            stake_text=f"{m.bti_stake_krw:,.0f} KRW" if m.bti_stake_krw else "",
        )
        self.site_bc.update_from(
            selection=m.bc_display_selection,
            odds=m.bc_odds,
            status_label=m.bc_site_label,
            odds_dir=m.bc_odds_dir,
            odds_changed_at=m.bc_odds_changed_at,
            stake_text=(
                f"{m.bc_stake_usdt:.2f} USDT · {m.bc_stake_krw:,.0f} KRW"
                if m.bc_stake_usdt and m.bc_stake_krw
                else ""
            ),
        )
        self.lbl_x10_stake.setText(f"텐텐벳 {m.bti_stake_krw:,.0f} KRW" if m.bti_stake_krw else "텐텐벳 —")
        bc_stake = (
            f"BC {m.bc_stake_usdt:.2f} USDT · {m.bc_stake_krw:,.0f} KRW"
            if m.bc_stake_usdt and m.bc_stake_krw
            else "BC —"
        )
        self.lbl_bc_stake.setText(bc_stake)
        self.lbl_total_stake.setText(f"총 {m.total_stake_krw:,.0f} KRW" if m.total_stake_krw else "총 —")
        self.checklist.update_checks(m)
        self.stabilize_bar.update_progress(m)
        self._update_banner(m, state, message or m.message)
        self._update_dashboard_glow(m, state)
        self._last_state = state

    def _update_top_cards(self, m: WatchMetrics, state: str) -> None:
        bridge_ok = m.bridge_connected or self._bridge_text == "CONNECTED"
        self.card_bridge.update_card(
            self._bridge_text,
            "CONNECTED" if bridge_ok else "WAIT",
            "success" if bridge_ok else "warning",
        )
        bc_kind = _status_kind(m.bc_site_label)
        self.card_bc.update_card(
            f"{m.bc_odds:.2f}" if m.bc_odds else "—",
            m.bc_site_label,
            bc_kind,
        )
        x10_kind = _status_kind(m.x10_site_label)
        self.card_x10.update_card(
            f"{m.bti_odds:.2f}" if m.bti_odds else "—",
            m.x10_site_label,
            x10_kind,
        )
        self.card_fx.update_card(self._fx_text, "LIVE" if m.fx_rate else "—", "primary" if m.fx_rate else "idle")
        if m.watch_enabled:
            watch_val = "ON"
            watch_badge = _STATE_LABELS.get(state, state)[:12]
            watch_kind = "success" if state == "READY" else "primary"
        else:
            watch_val = "OFF"
            watch_badge = "중지"
            watch_kind = "idle"
        self.card_watch.update_card(watch_val, watch_badge, watch_kind)

    def _update_banner(self, m: WatchMetrics, state: str, message: str) -> None:
        if not m.watch_enabled:
            self.status_banner.hide_banner()
            return
        profit = ""
        if m.total_stake_krw:
            sign = "+" if m.current_profit_rate >= 0 else ""
            profit = f"현재 수익률 {sign}{m.current_profit_rate:.2f}%"
        if state == "READY":
            self.status_banner.show_ready(profit)
        elif state in {"PREPARING", "DISPATCHING", "VERIFYING RESULT"}:
            self.status_banner.show_dispatching()
        elif state == "PARTIAL BET":
            self.status_banner.show_partial(message)
        elif state == "AUTO BET WAIT" and ("닫" in message):
            self.status_banner.show_closed(message)
        else:
            self.status_banner.hide_banner()

    def _update_dashboard_glow(self, m: WatchMetrics, state: str) -> None:
        if not m.watch_enabled:
            glow = "normal"
        elif state == "READY":
            glow = "ready"
        elif state in {"PARTIAL BET", "FAILED"}:
            glow = "alert"
        elif state == "AUTO BET WAIT" and ("닫" in (m.message or "")):
            glow = "warn"
        else:
            glow = "normal"
        self.setProperty("glow", glow)
        self.style().unpolish(self)
        self.style().polish(self)


_STATE_LABELS = {
    "IDLE": "IDLE",
    "TARGET WAIT": "목표 대기",
    "STABILIZING": "안정화",
    "READY": "READY",
    "AUTO BET WAIT": "대기",
    "PREPARING": "준비",
    "DISPATCHING": "배팅중",
    "VERIFYING RESULT": "확인",
    "SUCCESS": "완료",
    "PARTIAL BET": "부분체결",
    "FAILED": "실패",
}
