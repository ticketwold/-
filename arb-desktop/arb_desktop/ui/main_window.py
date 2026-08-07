from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PyQt6.QtCore import Qt, QThread
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QStatusBar,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from arb_desktop.bridge.instance_lock import ensure_single_instance
from arb_desktop.bridge.message_models import BridgeConnectionState, BridgeStatus
from arb_desktop.ui.betting_info_card import BettingInfoPanel
from arb_desktop.ui.bridge_worker import BridgeWorker
from arb_desktop.ui.log_manager import LogManager
from arb_desktop.ui.log_window import LogWindow
from arb_desktop.ui.settings_dialog import SettingsDialog
from arb_desktop.ui.settings_store import AppSettings, SettingsStore
from arb_desktop.ui.setup_wizard import SetupWizard
from arb_desktop.ui.theme_manager import apply_theme
from arb_desktop.ui.watch_engine import WatchMetrics
from arb_desktop.ui.x10_debug_panel import X10DebugPanel


STATE_DISPLAY: dict[str, str] = {
    "IDLE": "IDLE",
    "TARGET WAIT": "목표 수익률 대기",
    "STABILIZING": "배당 안정화 중",
    "READY": "자동배팅 준비 완료",
    "AUTO BET WAIT": "자동배팅 대기",
    "BET TYPE MISMATCH": "배팅 타입 불일치",
    "PREPARING": "동시 배팅 준비",
    "DISPATCHING": "양쪽 배팅 동시 전송 중",
    "VERIFYING RESULT": "결과 확인",
    "SUCCESS": "SUCCESS",
    "PARTIAL BET": "일부 배팅 성공 — 수동 확인 필요",
    "FAILED": "FAILED",
}


def _chrome_bridge_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "chrome-bridge"  # type: ignore[attr-defined]
    return Path(__file__).resolve().parents[3] / "chrome-bridge"


class _VerticalScrollArea(QScrollArea):
    def __init__(self, content: QWidget, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._content = content
        self.setWidget(self._content)
        self.setWidgetResizable(False)
        self.setFrameShape(QScrollArea.Shape.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self._sync_content_width()

    def _sync_content_width(self) -> None:
        width = max(self.viewport().width(), 720)
        self._content.setFixedWidth(width)
        self._content.adjustSize()
        self._content.setMinimumHeight(self._content.sizeHint().height())

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._sync_content_width()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("arb-desktop — 양방 배팅")
        self.setMinimumSize(720, 480)
        self.resize(960, 640)

        self._store = SettingsStore()
        self._settings = self._store.load()
        self._store.apply_to_runtime(self._settings)

        self._log_window: LogWindow | None = None
        self._log = LogManager(self._store.logs_dir, on_entry=self._on_log_entry)
        self._log_collapsed = True

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)
        self.tabs = QTabWidget()
        root.addWidget(self.tabs)

        dashboard = QWidget()
        dash = QVBoxLayout(dashboard)
        dash.setSpacing(10)
        dash.addWidget(self._build_top_status())
        dash.addWidget(self._build_betting_panel())
        dash.addWidget(self._build_profit_panel())
        dash.addWidget(self._build_engine_panel())
        dash.addWidget(self._build_action_bar())

        scroll = _VerticalScrollArea(dashboard)
        self.tabs.addTab(scroll, "메인")
        self.x10_debug_panel = X10DebugPanel()
        self.tabs.addTab(self.x10_debug_panel, "Debug")

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.status.showMessage("Bridge 시작 중…")

        self._thread = QThread()
        self._worker = BridgeWorker(self._store)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.bootstrap)
        self._worker.ready.connect(self._on_bridge_ready)
        self._worker.error.connect(self._on_error)
        self._worker.bridge_status.connect(self._on_bridge_status)
        self._worker.slip_updated.connect(self._on_slip_updated)
        self._worker.x10_debug.connect(self._on_x10_debug)
        self._worker.watch_state.connect(self._on_watch_state)
        self._worker.live_metrics.connect(self._on_live_metrics)
        self._worker.fx_updated.connect(self._on_fx_updated)
        self._worker.log_message.connect(self._on_worker_log)

        self._wire_buttons()
        self._refresh_settings_labels()
        self._thread.start()

        if not self._settings.setup_completed:
            self._run_setup_wizard()

    def _build_top_status(self) -> QGroupBox:
        box = QGroupBox("연결")
        row = QHBoxLayout(box)
        small = QFont()
        small.setPointSize(10)
        self.lbl_bridge = QLabel("Bridge: WAITING")
        self.lbl_bc_tab = QLabel("BC: —")
        self.lbl_x10_tab = QLabel("x10: —")
        self.lbl_fx_chip = QLabel("FX: —")
        self.lbl_extension = QLabel("확장: —")
        for lbl in (self.lbl_bridge, self.lbl_bc_tab, self.lbl_x10_tab, self.lbl_fx_chip, self.lbl_extension):
            lbl.setFont(small)
            row.addWidget(lbl)
        row.addStretch()
        self.btn_repair = QPushButton("페어링")
        self.btn_reset_conn = QPushButton("초기화")
        row.addWidget(self.btn_repair)
        row.addWidget(self.btn_reset_conn)
        return box

    def _build_betting_panel(self) -> BettingInfoPanel:
        self.betting_panel = BettingInfoPanel()
        return self.betting_panel

    def _build_profit_panel(self) -> QGroupBox:
        box = QGroupBox("수익 / 배당")
        grid = QGridLayout(box)
        hero = QFont()
        hero.setPointSize(22)
        hero.setWeight(QFont.Weight.Bold)
        muted = QFont()
        muted.setPointSize(10)

        self.lbl_current_rate = QLabel("—")
        self.lbl_current_rate.setFont(hero)
        self.lbl_current_rate.setProperty("class", "hero")
        self.lbl_bti_odds = QLabel("—")
        self.lbl_bc_odds = QLabel("—")
        self.lbl_bc_stake = QLabel("—")
        self.lbl_total_stake = QLabel("—")
        self.lbl_min_profit = QLabel("—")
        self.lbl_target_delta = QLabel("—")
        for lbl in (self.lbl_bti_odds, self.lbl_bc_odds, self.lbl_bc_stake):
            lbl.setProperty("class", "metric")

        grid.addWidget(QLabel("현재 수익률"), 0, 0)
        grid.addWidget(self.lbl_current_rate, 0, 1)
        grid.addWidget(QLabel("텐텐벳 배당"), 1, 0)
        grid.addWidget(self.lbl_bti_odds, 1, 1)
        grid.addWidget(QLabel("BC 배당"), 1, 2)
        grid.addWidget(self.lbl_bc_odds, 1, 3)
        grid.addWidget(QLabel("BC 금액"), 2, 0)
        grid.addWidget(self.lbl_bc_stake, 2, 1)
        grid.addWidget(QLabel("총 배팅금"), 2, 2)
        grid.addWidget(self.lbl_total_stake, 2, 3)
        grid.addWidget(QLabel("최저 보장 수익"), 3, 0)
        grid.addWidget(self.lbl_min_profit, 3, 1)
        grid.addWidget(QLabel("목표까지"), 3, 2)
        grid.addWidget(self.lbl_target_delta, 3, 3)
        self.lbl_fx_detail = QLabel("")
        self.lbl_fx_detail.setFont(muted)
        self.lbl_fx_detail.setProperty("class", "muted")
        grid.addWidget(self.lbl_fx_detail, 4, 0, 1, 4)
        return box

    def _build_engine_panel(self) -> QGroupBox:
        box = QGroupBox("자동배팅 상태")
        layout = QVBoxLayout(box)
        self.lbl_engine_state = QLabel("IDLE")
        f = QFont()
        f.setPointSize(18)
        f.setWeight(QFont.Weight.Bold)
        self.lbl_engine_state.setFont(f)
        self.lbl_engine_msg = QLabel("")
        self.lbl_dispatch_note = QLabel("")
        self.lbl_dispatch_note.setWordWrap(True)
        self.lbl_dispatch_note.setProperty("class", "muted")
        self.chk_confirm = QCheckBox("양쪽 카트가 서로 반대 선택임을 확인했습니다")
        self.lbl_last_log = QLabel("—")
        self.lbl_last_log.setWordWrap(True)
        self.lbl_last_log.setProperty("class", "muted")
        self.btn_toggle_log = QPushButton("로그 펼치기")
        layout.addWidget(self.lbl_engine_state)
        layout.addWidget(self.lbl_engine_msg)
        layout.addWidget(self.lbl_dispatch_note)
        layout.addWidget(self.chk_confirm)
        layout.addWidget(self.btn_toggle_log)
        layout.addWidget(self.lbl_last_log)
        self.lbl_last_log.setVisible(False)
        return box

    def _build_action_bar(self) -> QWidget:
        w = QWidget()
        row = QHBoxLayout(w)
        self.btn_watch_start = QPushButton("자동감시 시작")
        self.btn_watch_start.setProperty("class", "primary")
        self.btn_watch_stop = QPushButton("중지")
        self.btn_watch_stop.setEnabled(False)
        self.btn_dry_test = QPushButton("드라이런")
        self.btn_settings = QPushButton("설정")
        self.btn_reconnect = QPushButton("연결 확인")
        self.btn_log = QPushButton("로그 창")
        self.btn_quit = QPushButton("종료")
        self.btn_quit.setProperty("class", "danger")
        for btn in (
            self.btn_watch_start,
            self.btn_watch_stop,
            self.btn_dry_test,
            self.btn_settings,
            self.btn_reconnect,
            self.btn_log,
            self.btn_quit,
        ):
            row.addWidget(btn)
        return w

    def _wire_buttons(self) -> None:
        self.btn_reconnect.clicked.connect(self._worker.reconnect)
        self.btn_repair.clicked.connect(self._worker.repair_pairing)
        self.btn_reset_conn.clicked.connect(self._on_reset_connection)
        self.btn_watch_start.clicked.connect(self._start_watch)
        self.btn_watch_stop.clicked.connect(self._stop_watch)
        self.btn_dry_test.clicked.connect(self._dry_run_test)
        self.btn_settings.clicked.connect(self._open_settings)
        self.btn_log.clicked.connect(self._open_log_window)
        self.btn_toggle_log.clicked.connect(self._toggle_log_preview)
        self.btn_quit.clicked.connect(self.close)
        self.chk_confirm.toggled.connect(self._on_confirm_toggled)

    def _refresh_settings_labels(self) -> None:
        s = self._settings
        self.lbl_fx_detail.setText(
            f"목표 {s.target_profit_pct:.2f}% · 텐텐벳 {s.bti_stake_krw:,} KRW · "
            f"안정화 {s.stabilize_seconds:.1f}s × {s.stable_count_required}"
        )

    def _open_settings(self) -> None:
        dlg = SettingsDialog(self._settings, self)
        if dlg.exec():
            self._settings = dlg.collect()
            self._store.save(self._settings)
            self._worker.update_settings(self._settings)
            apply_theme(QApplication.instance(), self._settings.ui_theme)  # type: ignore[arg-type]
            self._refresh_settings_labels()
            self.status.showMessage("설정 저장됨")

    def _toggle_log_preview(self) -> None:
        self._log_collapsed = not self._log_collapsed
        self.lbl_last_log.setVisible(not self._log_collapsed)
        self.btn_toggle_log.setText("로그 접기" if not self._log_collapsed else "로그 펼치기")

    def _on_reset_connection(self) -> None:
        if QMessageBox.question(self, "연결 초기화", "credential을 재발급합니다.") == QMessageBox.StandardButton.Yes:
            self._worker.reset_connection()
            self.status.showMessage("연결 초기화됨")

    def _run_setup_wizard(self) -> None:
        wizard = SetupWizard(self)
        if wizard.exec():
            self._settings.setup_completed = True
            self._store.save(self._settings)

    def _on_bridge_ready(self) -> None:
        self.status.showMessage("Bridge 실행 중")
        self.btn_watch_start.setEnabled(True)

    def _on_bridge_status(self, status: BridgeStatus) -> None:
        bridge = "CONNECTED" if status.bridge == BridgeConnectionState.CONNECTED else status.bridge.value
        self.lbl_bridge.setText(f"Bridge: {bridge}")
        self.lbl_bc_tab.setText(f"BC: {status.bc_tab.value}")
        self.lbl_x10_tab.setText(f"x10: {status.x10_tab.value}")
        if status.extension_id:
            short = status.extension_id[:8] + "…"
            self.lbl_extension.setText(f"확장: {short}")
        if status.bridge == BridgeConnectionState.CONNECTED:
            self.status.showMessage("Chrome Bridge 연결됨")

    def _on_slip_updated(self, site: str, read) -> None:
        if site == "bti" and getattr(read, "raw", None):
            self.x10_debug_panel.update_from_slip_raw(read.raw)
        self._request_metrics_refresh()

    def _on_fx_updated(self, snap) -> None:
        if snap.rate:
            self.lbl_fx_chip.setText(f"FX: {snap.rate:,.0f}")
        self._refresh_settings_labels()

    def _on_live_metrics(self, m: WatchMetrics) -> None:
        self.betting_panel.update_metrics(m)
        self._apply_metrics(m)
        if m.x10_parse_debug:
            self.x10_debug_panel.update_parse_debug(m.x10_parse_debug)

    def _on_confirm_toggled(self, checked: bool) -> None:
        self._worker.set_user_confirmed(checked)
        self._request_metrics_refresh()

    def _on_x10_debug(self, payload: dict) -> None:
        self.x10_debug_panel.update_from_payload(payload)

    def _on_watch_state(self, state: str, metrics: WatchMetrics, message: str) -> None:
        self.lbl_engine_state.setText(STATE_DISPLAY.get(state, state))
        self.lbl_engine_msg.setText(message)
        self.lbl_dispatch_note.setText(metrics.dispatch_note)
        self.betting_panel.update_metrics(metrics)
        self._apply_metrics(metrics)
        css = ""
        if state in ("PARTIAL BET", "FAILED", "BET TYPE MISMATCH"):
            css = "status-bad"
        elif state == "READY":
            css = "status-ok"
        elif state in ("AUTO BET WAIT", "STABILIZING", "TARGET WAIT"):
            css = "status-warn"
        self.lbl_engine_state.setProperty("class", css)
        self.lbl_engine_state.style().unpolish(self.lbl_engine_state)
        self.lbl_engine_state.style().polish(self.lbl_engine_state)

    def _on_worker_log(self, site: str, status: str, odds: str, profit: str, message: str, dedup: str) -> None:
        self._log.log(site=site, status=status, odds=odds, profit=profit, message=message, dedup_key=dedup)

    def _on_log_entry(self, entry) -> None:
        line = entry.format_line()
        self.lbl_last_log.setText(line)
        if self._log_window:
            self._log_window.append(entry.timestamp, entry.site, entry.status, entry.odds, entry.profit, entry.message)

    def _on_error(self, msg: str) -> None:
        self.status.showMessage(f"오류: {msg}")

    def _apply_metrics(self, m: WatchMetrics) -> None:
        self.lbl_bti_odds.setText(f"{m.bti_odds:.3f}" if m.bti_odds else "—")
        self.lbl_bc_odds.setText(f"{m.bc_odds:.3f}" if m.bc_odds else "—")
        self.lbl_bc_stake.setText(f"{m.bc_stake_usdt:.1f} USDT" if m.bc_stake_usdt else "—")
        self.lbl_total_stake.setText(f"{m.total_stake_krw:,.0f} KRW" if m.total_stake_krw else "—")
        self.lbl_min_profit.setText(f"{m.min_guaranteed_profit_krw:,.0f} KRW" if m.total_stake_krw else "—")
        if m.total_stake_krw:
            self.lbl_current_rate.setText(f"{m.current_profit_rate:.2f} %")
            delta = m.target_delta_pct
            sign = "+" if delta >= 0 else ""
            self.lbl_target_delta.setText(f"{sign}{delta:.2f}%p")
        else:
            self.lbl_current_rate.setText("—")
            self.lbl_target_delta.setText("—")
        if m.fx_rate:
            self.lbl_fx_chip.setText(f"FX: {m.fx_rate:,.0f}")

    def _request_metrics_refresh(self) -> None:
        self._worker.update_settings(self._settings)

    def _start_watch(self) -> None:
        if not self.chk_confirm.isChecked():
            self.status.showMessage("반대 선택 확인이 필요합니다")
            return
        self._worker.set_user_confirmed(True)
        self._worker.update_settings(self._settings)
        self._worker.start_watch()
        self.btn_watch_start.setEnabled(False)
        self.btn_watch_stop.setEnabled(True)

    def _stop_watch(self) -> None:
        self._worker.stop_watch()
        self.btn_watch_start.setEnabled(True)
        self.btn_watch_stop.setEnabled(False)

    def _dry_run_test(self) -> None:
        self._worker.update_settings(self._settings)
        self._worker.start_watch()
        self.status.showMessage("드라이런 감시 시작")

    def _open_log_window(self) -> None:
        if not self._log_window:
            self._log_window = LogWindow(self)
        self._log_window.show()
        path = self._log.open_log_file()
        if sys.platform == "win32":
            os.startfile(path)  # type: ignore[attr-defined]
        else:
            subprocess.run(["xdg-open", str(path)], check=False)

    def closeEvent(self, event) -> None:
        self._worker.stop_watch()
        self._worker.stop_bridge()
        self._thread.quit()
        self._thread.wait(3000)
        super().closeEvent(event)


def run_app() -> int:
    lock = ensure_single_instance()
    if not lock.ok:
        app = QApplication(sys.argv)
        QMessageBox.warning(None, "arb-desktop", lock.message)
        return 1

    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    app = QApplication(sys.argv)
    app.setApplicationName("arb-desktop")
    app.setStyle("Fusion")

    store = SettingsStore()
    settings = store.load()
    apply_theme(app, settings.ui_theme)

    win = MainWindow()
    win.show()
    return app.exec()
