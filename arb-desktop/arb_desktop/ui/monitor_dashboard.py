from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QProgressBar,
    QVBoxLayout,
    QWidget,
)

from arb_desktop.ui.betting_info_card import BettingInfoPanel
from arb_desktop.ui.watch_engine import WatchMetrics

def _odds_arrow(direction: int) -> str:
    if direction > 0:
        return "↑"
    if direction < 0:
        return "↓"
    return "—"


def _odds_dir_class(direction: int) -> str:
    if direction > 0:
        return "odds-up"
    if direction < 0:
        return "odds-down"
    return "odds-flat"


class WatchStatusPanel(QFrame):
    """자동감시 ON/OFF + 현재 조건 분리 표시."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "Card")
        self.setObjectName("WatchStatusPanel")
        layout = QHBoxLayout(self)
        layout.setSpacing(24)

        watch_col = QVBoxLayout()
        self.lbl_watch_title = QLabel("자동감시")
        self.lbl_watch_title.setProperty("class", "muted")
        self.lbl_watch_dot = QLabel("● OFF")
        self.lbl_watch_dot.setProperty("class", "watch-off")
        self.lbl_watch_sub = QLabel("감시 중지됨")
        self.lbl_watch_sub.setProperty("class", "muted")
        self.lbl_watch_started = QLabel("")
        self.lbl_watch_started.setProperty("class", "muted")
        watch_col.addWidget(self.lbl_watch_title)
        watch_col.addWidget(self.lbl_watch_dot)
        watch_col.addWidget(self.lbl_watch_sub)
        watch_col.addWidget(self.lbl_watch_started)

        cond_col = QVBoxLayout()
        self.lbl_cond_title = QLabel("현재 조건")
        self.lbl_cond_title.setProperty("class", "muted")
        self.lbl_cond_state = QLabel("IDLE")
        self.lbl_cond_state.setProperty("class", "engine-state")
        self.lbl_cond_msg = QLabel("")
        self.lbl_cond_msg.setProperty("class", "muted")
        self.lbl_cond_msg.setWordWrap(True)
        cond_col.addWidget(self.lbl_cond_title)
        cond_col.addWidget(self.lbl_cond_state)
        cond_col.addWidget(self.lbl_cond_msg)

        layout.addLayout(watch_col, 1)
        layout.addLayout(cond_col, 2)

    def update_status(self, m: WatchMetrics, *, state: str = "", message: str = "") -> None:
        state = state or m.engine_state or "IDLE"
        if m.watch_enabled:
            self.lbl_watch_dot.setText("● ON")
            self.lbl_watch_dot.setProperty("class", "watch-on")
            self.lbl_watch_sub.setText("실시간 배당 감시 중")
            started = f"시작: {m.watch_started_at}" if m.watch_started_at else ""
            self.lbl_watch_started.setText(started)
        else:
            self.lbl_watch_dot.setText("● OFF")
            self.lbl_watch_dot.setProperty("class", "watch-off")
            self.lbl_watch_sub.setText("감시 중지됨")
            self.lbl_watch_started.setText("")

        for w in (self.lbl_watch_dot,):
            w.style().unpolish(w)
            w.style().polish(w)

        if not m.watch_enabled:
            cond = "감시 중지"
            cond_css = "engine-state status-idle"
        else:
            cond = _STATE_LABELS.get(state, state)
            cond_css = _state_css(state)

        self.lbl_cond_state.setText(cond)
        self.lbl_cond_state.setProperty("class", cond_css)
        self.lbl_cond_state.style().unpolish(self.lbl_cond_state)
        self.lbl_cond_state.style().polish(self.lbl_cond_state)
        self.lbl_cond_msg.setText(message or m.message or "")

        glow = "watch-on" if m.watch_enabled else "watch-off"
        self.setProperty("glow", glow)
        self.style().unpolish(self)
        self.style().polish(self)


class ProfitHeroPanel(QFrame):
    """현재 수익률 · 목표까지 — 가장 크게 표시."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "Card")
        self.setObjectName("ProfitHero")
        layout = QVBoxLayout(self)
        layout.setSpacing(4)

        self.lbl_title = QLabel("현재 수익률")
        self.lbl_title.setProperty("class", "muted")
        self.lbl_rate = QLabel("—")
        self.lbl_rate.setProperty("class", "profit-hero")
        self.lbl_rate.setAlignment(Qt.AlignmentFlag.AlignCenter)

        row = QHBoxLayout()
        self.lbl_target_label = QLabel("목표까지")
        self.lbl_target_label.setProperty("class", "muted")
        self.lbl_target_delta = QLabel("—")
        self.lbl_target_delta.setProperty("class", "target-delta")
        self.lbl_target_pct = QLabel("목표 —")
        self.lbl_target_pct.setProperty("class", "muted")
        self.lbl_min_profit = QLabel("최저 보장 —")
        self.lbl_min_profit.setProperty("class", "muted")
        row.addWidget(self.lbl_target_label)
        row.addWidget(self.lbl_target_delta)
        row.addWidget(self.lbl_target_pct)
        row.addStretch()
        row.addWidget(self.lbl_min_profit)

        layout.addWidget(self.lbl_title, alignment=Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.lbl_rate)
        layout.addLayout(row)

    def update_metrics(self, m: WatchMetrics) -> None:
        if m.total_stake_krw:
            rate = m.current_profit_rate
            self.lbl_rate.setText(f"{rate:.2f}%")
            delta = m.target_delta_pct
            sign = "+" if delta >= 0 else ""
            self.lbl_target_delta.setText(f"{sign}{delta:.2f}%p")
            css = "target-hit" if delta >= 0 else "target-miss"
            self.lbl_target_delta.setProperty("class", css)
            self.lbl_target_delta.style().unpolish(self.lbl_target_delta)
            self.lbl_target_delta.style().polish(self.lbl_target_delta)
            self.lbl_min_profit.setText(f"최저 보장 {m.min_guaranteed_profit_krw:,.0f} KRW")
            self.lbl_target_pct.setText(f"목표 {m.target_profit_pct:.2f}%")
            rate_css = "profit-positive" if rate >= m.target_profit_pct else "profit-negative"
            self.lbl_rate.setProperty("class", rate_css)
            self.lbl_rate.style().unpolish(self.lbl_rate)
            self.lbl_rate.style().polish(self.lbl_rate)
        else:
            self.lbl_rate.setText("—")
            self.lbl_target_delta.setText("—")
            self.lbl_target_pct.setText("목표 —")
            self.lbl_min_profit.setText("최저 보장 —")


class OddsTickerCard(QFrame):
    """사이트별 배당 + 화살표 + 변경 시각."""

    def __init__(self, site_name: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "Card")
        layout = QVBoxLayout(self)
        layout.setSpacing(6)

        self.lbl_site = QLabel(site_name)
        self.lbl_site.setProperty("class", "site-label")

        odds_row = QHBoxLayout()
        self.lbl_odds = QLabel("—")
        self.lbl_odds.setProperty("class", "odds-big")
        self.lbl_arrow = QLabel("")
        self.lbl_arrow.setProperty("class", "odds-flat")
        odds_row.addWidget(self.lbl_odds)
        odds_row.addWidget(self.lbl_arrow)
        odds_row.addStretch()

        self.lbl_changed = QLabel("변경 —")
        self.lbl_changed.setProperty("class", "muted")
        self.lbl_stake = QLabel("")
        self.lbl_stake.setProperty("class", "muted")

        layout.addWidget(self.lbl_site)
        layout.addLayout(odds_row)
        layout.addWidget(self.lbl_changed)
        layout.addWidget(self.lbl_stake)

    def update_odds(
        self,
        *,
        odds: float | None,
        direction: int,
        changed_at: str,
        stake_text: str = "",
    ) -> None:
        self.lbl_odds.setText(f"{odds:.3f}" if odds else "—")
        arrow = _odds_arrow(direction)
        self.lbl_arrow.setText(arrow if odds else "")
        css = _odds_dir_class(direction)
        self.lbl_arrow.setProperty("class", css)
        self.lbl_arrow.style().unpolish(self.lbl_arrow)
        self.lbl_arrow.style().polish(self.lbl_arrow)
        self.lbl_changed.setText(f"변경 {changed_at}" if changed_at else "변경 —")
        if stake_text:
            self.lbl_stake.setText(stake_text)
            self.lbl_stake.setVisible(True)
        else:
            self.lbl_stake.setVisible(False)


class ReadinessChecklist(QGroupBox):
    CHECK_ITEMS = (
        ("bridge", "Bridge 연결"),
        ("bc_active", "BC ACTIVE"),
        ("x10_active", "x10 ACTIVE"),
        ("stabilized", "배당 안정화"),
        ("target", "목표 수익률"),
        ("ready", "READY"),
    )

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__("자동배팅 체크리스트", parent)
        layout = QGridLayout(self)
        layout.setHorizontalSpacing(16)
        layout.setVerticalSpacing(6)
        self._labels: dict[str, QLabel] = {}
        for i, (key, text) in enumerate(self.CHECK_ITEMS):
            lbl = QLabel(f"□ {text}")
            lbl.setProperty("class", "check-pending")
            self._labels[key] = lbl
            layout.addWidget(lbl, i // 2, i % 2)

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
            sym = "☑" if ok else "□"
            lbl = self._labels[key]
            lbl.setText(f"{sym} {text}")
            lbl.setProperty("class", "check-ok" if ok else "check-pending")
            lbl.style().unpolish(lbl)
            lbl.style().polish(lbl)


class StatusBanner(QFrame):
    """READY / 부분체결 / 배팅닫힘 / 배팅중 배너."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("StatusBanner")
        self.hide()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 16, 20, 16)
        self.lbl_stars = QLabel("")
        self.lbl_stars.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_title = QLabel("")
        self.lbl_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_sub = QLabel("")
        self.lbl_sub.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_sub.setWordWrap(True)
        for w in (self.lbl_stars, self.lbl_title, self.lbl_sub):
            w.setProperty("class", "banner-text")
            layout.addWidget(w)

        self._anim_timer = QTimer(self)
        self._anim_timer.setInterval(400)
        self._anim_timer.timeout.connect(self._tick_anim)
        self._anim_dots = 0
        self._anim_base = ""

    def _tick_anim(self) -> None:
        self._anim_dots = (self._anim_dots + 1) % 4
        dots = "." * self._anim_dots
        self.lbl_title.setText(f"{self._anim_base}{dots}")

    def hide_banner(self) -> None:
        self._anim_timer.stop()
        self.hide()

    def show_ready(self) -> None:
        self._anim_timer.stop()
        self.setProperty("banner", "ready")
        self.lbl_stars.setText("★" * 12)
        self.lbl_title.setText("READY")
        self.lbl_title.setProperty("class", "banner-ready-title")
        self.lbl_sub.setText("자동배팅 가능")
        self._apply_banner_style()
        self.show()

    def show_dispatching(self) -> None:
        self.setProperty("banner", "dispatching")
        self.lbl_stars.setText("")
        self._anim_base = "양쪽 동시 배팅 중"
        self._anim_dots = 0
        self.lbl_title.setProperty("class", "banner-dispatch-title")
        self.lbl_sub.setText("병렬 실행 — 체결 시점은 사이트 응답 속도에 따라 다를 수 있음")
        self._apply_banner_style()
        self._anim_timer.start()
        self.show()

    def show_partial(self, message: str = "") -> None:
        self._anim_timer.stop()
        self.setProperty("banner", "partial")
        self.lbl_stars.setText("⚠")
        self.lbl_title.setText("부분 체결")
        self.lbl_title.setProperty("class", "banner-partial-title")
        self.lbl_sub.setText(message or "일부 배팅 성공 — 수동 확인 필요")
        self._apply_banner_style()
        self.show()

    def show_closed(self, message: str) -> None:
        self._anim_timer.stop()
        self.setProperty("banner", "closed")
        self.lbl_stars.setText("⚠")
        self.lbl_title.setText("자동배팅 대기")
        self.lbl_title.setProperty("class", "banner-closed-title")
        self.lbl_sub.setText(message)
        self._apply_banner_style()
        self.show()

    def _apply_banner_style(self) -> None:
        self.style().unpolish(self)
        self.style().polish(self)
        for w in (self.lbl_title, self.lbl_sub, self.lbl_stars):
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
        if not m.watch_enabled:
            self.hide()
            return
        if m.engine_state not in {"STABILIZING", "READY", "TARGET WAIT"} or not m.stable_count_required:
            self.hide()
            return
        count_pct = min(100, int(100 * m.stable_count / max(m.stable_count_required, 1)))
        time_pct = 0
        if m.stabilize_seconds > 0:
            time_pct = min(100, int(100 * m.stabilize_elapsed / m.stabilize_seconds))
        pct = min(count_pct, time_pct) if m.engine_state == "STABILIZING" else 100
        self.bar.setValue(pct)
        self.bar.setFormat(
            f"{m.stable_count}/{m.stable_count_required} · {m.stabilize_elapsed:.1f}s / {m.stabilize_seconds:.1f}s"
        )
        self.show()


class MonitorDashboard(QWidget):
    """실시간 트레이딩 모니터 대시보드."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("MonitorDashboard")
        root = QVBoxLayout(self)
        root.setSpacing(12)

        self.status_banner = StatusBanner()
        root.addWidget(self.status_banner)

        self.watch_status = WatchStatusPanel()
        root.addWidget(self.watch_status)

        self.profit_hero = ProfitHeroPanel()
        root.addWidget(self.profit_hero)

        odds_row = QHBoxLayout()
        odds_row.setSpacing(12)
        self.odds_x10 = OddsTickerCard("텐텐벳 배당")
        self.odds_bc = OddsTickerCard("BC.Game 배당")
        odds_row.addWidget(self.odds_x10)
        odds_row.addWidget(self.odds_bc)
        root.addLayout(odds_row)

        self.betting_panel = BettingInfoPanel()
        root.addWidget(self.betting_panel)

        stakes = QHBoxLayout()
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

        self._last_state = ""

    def update_all(self, m: WatchMetrics, *, state: str = "", message: str = "") -> None:
        state = state or m.engine_state or "IDLE"
        self.watch_status.update_status(m, state=state, message=message)
        self.profit_hero.update_metrics(m)
        self.odds_x10.update_odds(
            odds=m.bti_odds,
            direction=m.bti_odds_dir,
            changed_at=m.bti_odds_changed_at,
            stake_text=f"{m.bti_stake_krw:,.0f} KRW" if m.bti_stake_krw else "",
        )
        self.odds_bc.update_odds(
            odds=m.bc_odds,
            direction=m.bc_odds_dir,
            changed_at=m.bc_odds_changed_at,
            stake_text=(
                f"{m.bc_stake_usdt:.2f} USDT · {m.bc_stake_krw:,.0f} KRW"
                if m.bc_stake_usdt and m.bc_stake_krw
                else (f"{m.bc_stake_usdt:.2f} USDT" if m.bc_stake_usdt else "")
            ),
        )
        self.lbl_x10_stake.setText(f"텐텐벳 {m.bti_stake_krw:,.0f} KRW" if m.bti_stake_krw else "텐텐벳 —")
        bc_stake = (
            f"BC {m.bc_stake_usdt:.2f} USDT · {m.bc_stake_krw:,.0f} KRW"
            if m.bc_stake_usdt and m.bc_stake_krw
            else "BC —"
        )
        self.lbl_bc_stake.setText(bc_stake)
        self.lbl_total_stake.setText(
            f"총 {m.total_stake_krw:,.0f} KRW" if m.total_stake_krw else "총 —"
        )
        self.betting_panel.update_metrics(m)
        self.checklist.update_checks(m)
        self.stabilize_bar.update_progress(m)

        self._update_banner(m, state, message or m.message)
        self._update_dashboard_glow(m, state)
        self._last_state = state

    def _update_banner(self, m: WatchMetrics, state: str, message: str) -> None:
        if not m.watch_enabled:
            self.status_banner.hide_banner()
            return
        if state == "READY":
            self.status_banner.show_ready()
        elif state in {"PREPARING", "DISPATCHING", "VERIFYING RESULT"}:
            self.status_banner.show_dispatching()
        elif state == "PARTIAL BET":
            self.status_banner.show_partial(message)
        elif state == "AUTO BET WAIT" and ("닫힘" in message or "닫" in message):
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
    "TARGET WAIT": "목표 수익률 대기",
    "STABILIZING": "배당 안정화 중",
    "READY": "자동배팅 준비 완료",
    "AUTO BET WAIT": "자동배팅 대기",
    "PREPARING": "동시 배팅 준비",
    "DISPATCHING": "양쪽 배팅 동시 전송 중",
    "VERIFYING RESULT": "결과 확인",
    "SUCCESS": "배팅 완료",
    "PARTIAL BET": "부분 체결",
    "FAILED": "배팅 실패",
}


def _state_css(state: str) -> str:
    if state in {"PARTIAL BET", "FAILED"}:
        return "engine-state status-bad"
    if state == "READY":
        return "engine-state status-ok"
    if state in {"AUTO BET WAIT", "STABILIZING", "TARGET WAIT"}:
        return "engine-state status-warn"
    if state in {"DISPATCHING", "PREPARING", "VERIFYING RESULT"}:
        return "engine-state status-dispatch"
    return "engine-state"
