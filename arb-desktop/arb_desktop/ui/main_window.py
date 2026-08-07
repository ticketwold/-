from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from PyQt6.QtCore import Qt, QThread
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
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

from arb_desktop.ui.console_log import ConsoleLogPanel
from arb_desktop.ui.icon_helper import icon
from arb_desktop.bridge.message_models import BridgeConnectionState, BridgeStatus
from arb_desktop.ui.bridge_worker import BridgeWorker
from arb_desktop.ui.log_manager import LogManager
from arb_desktop.ui.log_window import LogWindow
from arb_desktop.ui.monitor_dashboard import MonitorDashboard
from arb_desktop.ui.odds_log_manager import OddsLogEntry, OddsLogManager
from arb_desktop.ui.odds_log_panel import OddsLogPanel
from arb_desktop.ui.settings_dialog import SettingsDialog
from arb_desktop.ui.settings_store import AppSettings, SettingsStore
from arb_desktop.ui.setup_wizard import SetupWizard
from arb_desktop.ui.theme_manager import apply_theme
from arb_desktop.ui.watch_engine import WatchMetrics
from arb_desktop.ui.x10_debug_panel import X10DebugPanel


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
        width = max(self.viewport().width(), 800)
        self._content.setFixedWidth(width)
        self._content.adjustSize()
        self._content.setMinimumHeight(self._content.sizeHint().height())

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._sync_content_width()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("arb-desktop — 실시간 양방 모니터")
        self.setMinimumSize(800, 600)
        self.resize(1040, 780)

        self._store = SettingsStore()
        self._settings = self._store.load()
        self._store.apply_to_runtime(self._settings)

        self._log_window: LogWindow | None = None
        self._log = LogManager(self._store.logs_dir, on_entry=self._on_log_entry)
        self._odds_log = OddsLogManager(self._store.logs_dir, on_entry=self._on_odds_log_entry)
        self._current_state = "IDLE"
        self._watch_enabled_ui = False
        self._watch_started_at = ""
        self._bridge_label = "WAITING"
        self._bc_tab_label = "—"
        self._x10_tab_label = "—"
        self._fx_label = "—"

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)
        self.tabs = QTabWidget()
        root.addWidget(self.tabs)

        dashboard = QWidget()
        dash = QVBoxLayout(dashboard)
        dash.setSpacing(12)
        dash.setContentsMargins(4, 4, 4, 4)
        self.monitor = MonitorDashboard()
        dash.addWidget(self.monitor)
        dash.addWidget(self._build_action_section())
        self.console_log = ConsoleLogPanel()
        dash.addWidget(self.console_log)

        scroll = _VerticalScrollArea(dashboard)
        self.tabs.addTab(scroll, "메인")
        self.odds_log_panel = OddsLogPanel(self._odds_log, self._store.logs_dir)
        self.tabs.addTab(self.odds_log_panel, "배당 로그")
        self.x10_debug_panel = X10DebugPanel()
        self.tabs.addTab(self.x10_debug_panel, "Debug")

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.status.showMessage("Bridge 시작 중…")

        self._thread = QThread()
        self._worker = BridgeWorker(self._store)
        self._worker.attach_odds_log(self._odds_log)
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
        self._apply_watch_ui()
        self._refresh_settings_labels()
        self._thread.start()

        if not self._settings.setup_completed:
            self._run_setup_wizard()

    def _build_action_section(self) -> QWidget:
        box = QGroupBox("제어")
        layout = QVBoxLayout(box)
        layout.setSpacing(12)

        self.chk_confirm = QCheckBox("양쪽 카트가 서로 반대 선택임을 확인했습니다")
        layout.addWidget(self.chk_confirm)

        row = QHBoxLayout()
        row.setSpacing(8)
        self.btn_watch_start = QPushButton("  자동감시 시작")
        self.btn_watch_start.setIcon(icon("bet", "#FFFFFF"))
        self.btn_watch_start.setProperty("class", "primary")
        self.btn_watch_stop = QPushButton("  중지")
        self.btn_watch_stop.setEnabled(False)
        self.btn_watch_stop.setProperty("class", "watch-stop-idle")
        self.btn_dry_test = QPushButton("드라이런")
        self.btn_settings = QPushButton("  설정")
        self.btn_settings.setIcon(icon("settings", "#A8B0BE"))
        self.btn_reconnect = QPushButton("  연결 확인")
        self.btn_reconnect.setIcon(icon("bridge", "#4A90FF"))
        self.btn_odds_log = QPushButton("  배당 로그")
        self.btn_odds_log.setIcon(icon("log", "#A8B0BE"))
        self.btn_log = QPushButton("로그 창")
        self.btn_repair = QPushButton("페어링")
        self.btn_reset_conn = QPushButton("초기화")
        self.btn_quit = QPushButton("종료")
        self.btn_quit.setProperty("class", "danger")
        for btn in (
            self.btn_watch_start,
            self.btn_watch_stop,
            self.btn_dry_test,
            self.btn_settings,
            self.btn_reconnect,
            self.btn_odds_log,
            self.btn_log,
            self.btn_repair,
            self.btn_reset_conn,
            self.btn_quit,
        ):
            row.addWidget(btn)
        layout.addLayout(row)
        return box

    def _wire_buttons(self) -> None:
        self.btn_reconnect.clicked.connect(self._worker.reconnect)
        self.btn_repair.clicked.connect(self._worker.repair_pairing)
        self.btn_reset_conn.clicked.connect(self._on_reset_connection)
        self.btn_watch_start.clicked.connect(self._start_watch)
        self.btn_watch_stop.clicked.connect(self._stop_watch)
        self.btn_dry_test.clicked.connect(self._dry_run_test)
        self.btn_settings.clicked.connect(self._open_settings)
        self.btn_log.clicked.connect(self._open_log_window)
        self.btn_odds_log.clicked.connect(self._open_odds_log_tab)
        self.btn_quit.clicked.connect(self.close)
        self.chk_confirm.toggled.connect(self._on_confirm_toggled)

    def _apply_watch_ui(self) -> None:
        if self._watch_enabled_ui:
            self.btn_watch_start.setText("자동감시 실행 중")
            self.btn_watch_start.setEnabled(False)
            self.btn_watch_start.setProperty("class", "watch-on")
            self.btn_watch_stop.setEnabled(True)
            self.btn_watch_stop.setProperty("class", "watch-stop-active")
        else:
            self.btn_watch_start.setText("자동감시 시작")
            self.btn_watch_start.setEnabled(True)
            self.btn_watch_start.setProperty("class", "primary")
            self.btn_watch_stop.setEnabled(False)
            self.btn_watch_stop.setProperty("class", "watch-stop-idle")
        for btn in (self.btn_watch_start, self.btn_watch_stop):
            btn.style().unpolish(btn)
            btn.style().polish(btn)

    def _metrics_with_watch(self, m: WatchMetrics) -> WatchMetrics:
        m.watch_enabled = self._watch_enabled_ui
        if self._watch_enabled_ui and self._watch_started_at:
            m.watch_started_at = self._watch_started_at
        return m

    def _sync_connection_to_monitor(self) -> None:
        self.monitor.update_connection(
            bridge=self._bridge_label,
            bc_tab=self._bc_tab_label,
            x10_tab=self._x10_tab_label,
            fx=self._fx_label,
        )

    def _refresh_settings_labels(self) -> None:
        s = self._settings
        self.status.showMessage(
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

    def _open_odds_log_tab(self) -> None:
        self.tabs.setCurrentWidget(self.odds_log_panel)

    def _on_reset_connection(self) -> None:
        if QMessageBox.question(self, "연결 초기화", "credential을 재발급합니다.") == QMessageBox.StandardButton.Yes:
            self._worker.reset_connection()
            self._stop_watch()
            self.status.showMessage("연결 초기화됨")

    def _run_setup_wizard(self) -> None:
        wizard = SetupWizard(self)
        if wizard.exec():
            self._settings.setup_completed = True
            self._store.save(self._settings)

    def _on_bridge_ready(self) -> None:
        self.status.showMessage("Bridge 실행 중")
        if not self._watch_enabled_ui:
            self.btn_watch_start.setEnabled(True)

    def _on_bridge_status(self, status: BridgeStatus) -> None:
        self._bridge_label = (
            "CONNECTED" if status.bridge == BridgeConnectionState.CONNECTED else status.bridge.value
        )
        self._bc_tab_label = status.bc_tab.value
        self._x10_tab_label = status.x10_tab.value
        self._sync_connection_to_monitor()
        if status.bridge == BridgeConnectionState.CONNECTED:
            self.status.showMessage("Chrome Bridge 연결됨")

    def _on_fx_updated(self, snap) -> None:
        if snap.rate:
            self._fx_label = f"{snap.rate:,.0f}"
        self._sync_connection_to_monitor()
        self._refresh_settings_labels()

    def _on_slip_updated(self, site: str, read) -> None:
        if site == "bti" and getattr(read, "raw", None):
            self.x10_debug_panel.update_from_slip_raw(read.raw)
        self._request_metrics_refresh()

    def _on_live_metrics(self, m: WatchMetrics) -> None:
        m = self._metrics_with_watch(m)
        self._sync_connection_to_monitor()
        state = self._current_state if self._watch_enabled_ui else "IDLE"
        self.monitor.update_all(m, state=state)
        if m.x10_parse_debug:
            self.x10_debug_panel.update_parse_debug(m.x10_parse_debug)

    def _on_confirm_toggled(self, checked: bool) -> None:
        self._worker.set_user_confirmed(checked)
        self._request_metrics_refresh()

    def _on_x10_debug(self, payload: dict) -> None:
        self.x10_debug_panel.update_from_payload(payload)

    def _on_watch_state(self, state: str, metrics: WatchMetrics, message: str) -> None:
        if self._watch_enabled_ui:
            self._current_state = state
        else:
            self._current_state = "IDLE"
        m = self._metrics_with_watch(metrics)
        self.monitor.update_all(m, state=self._current_state, message=message)
        if m.x10_parse_debug:
            self.x10_debug_panel.update_parse_debug(m.x10_parse_debug)

    def _on_odds_log_entry(self, entry: OddsLogEntry) -> None:
        self.odds_log_panel.append_entry(entry)

    def _on_worker_log(self, site: str, status: str, odds: str, profit: str, message: str, dedup: str) -> None:
        self._log.log(site=site, status=status, odds=odds, profit=profit, message=message, dedup_key=dedup)

    def _on_log_entry(self, entry) -> None:
        self.console_log.append(entry)
        if self._log_window:
            self._log_window.append(entry.timestamp, entry.site, entry.status, entry.odds, entry.profit, entry.message)

    def _on_error(self, msg: str) -> None:
        self.status.showMessage(f"오류: {msg}")

    def _request_metrics_refresh(self) -> None:
        self._worker.update_settings(self._settings)

    def _start_watch(self) -> None:
        if not self.chk_confirm.isChecked():
            self.status.showMessage("반대 선택 확인이 필요합니다")
            return
        self._watch_enabled_ui = True
        self._watch_started_at = datetime.now().strftime("%H:%M:%S")
        self._current_state = "TARGET WAIT"
        self._apply_watch_ui()
        self._worker.set_user_confirmed(True)
        self._worker.update_settings(self._settings)
        self._worker.start_watch()
        self.status.showMessage("자동감시 ON — 실시간 배당 감시 중")

    def _stop_watch(self) -> None:
        self._watch_enabled_ui = False
        self._watch_started_at = ""
        self._current_state = "IDLE"
        self._apply_watch_ui()
        self._worker.stop_watch()
        m = self._metrics_with_watch(self._worker.watch_metrics)
        self.monitor.update_all(m, state="IDLE", message="감시 중지됨")
        self.status.showMessage("자동감시 OFF — 감시 중지됨")

    def _dry_run_test(self) -> None:
        if not self.chk_confirm.isChecked():
            self.status.showMessage("반대 선택 확인이 필요합니다")
            return
        self._start_watch()

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
