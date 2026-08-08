from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from PyQt6.QtCore import Qt, QThread, QTimer
from PyQt6.QtWidgets import (
    QApplication,
    QCheckBox,
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
from arb_desktop.ui.bc_slip_debug_panel import BcSlipDebugPanel
from arb_desktop.ui.bc_stake_debug_panel import BcStakeDebugPanel
from arb_desktop.ui.bridge_worker import BridgeWorker
from arb_desktop.ui.log_manager import LogManager
from arb_desktop.ui.log_window import LogWindow
from arb_desktop.ui.manual_bet_dialog import ManualBetDialog
from arb_desktop.ui.monitor_dashboard import MonitorDashboard
from arb_desktop.ui.odds_log_manager import OddsLogEntry, OddsLogManager
from arb_desktop.ui.odds_log_panel import OddsLogPanel
from arb_desktop.ui.pipeline_debug_overlay import PipelineDebugOverlay
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
        width = max(self.viewport().width(), 1240)
        self._content.setFixedWidth(width)
        self._content.adjustSize()
        self._content.setMinimumHeight(self._content.sizeHint().height())

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._sync_content_width()


class MainWindow(QMainWindow):
    def __init__(
        self,
        *,
        store: SettingsStore | None = None,
        settings: AppSettings | None = None,
    ) -> None:
        super().__init__()
        self.setWindowTitle("ARB DESKTOP")
        self.setMinimumSize(1280, 760)
        self.resize(1320, 860)

        self._store = store or SettingsStore()
        self._settings = settings or self._store.load()
        try:
            self._store.apply_to_runtime(self._settings)
        except Exception as exc:
            from arb_desktop.startup_crash import startup_log

            startup_log(f"[STARTUP 03] apply_to_runtime warning: {exc}")

        self._log_window: LogWindow | None = None
        self._log = LogManager(self._store.logs_dir, on_entry=self._on_log_entry)
        self._odds_log = OddsLogManager(self._store.logs_dir, on_entry=self._on_odds_log_entry)
        self._current_state = "IDLE"
        self._watch_enabled_ui = False
        self._watch_started_at = ""
        self._partial_locked = False

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(10, 10, 10, 10)
        self.tabs = QTabWidget()
        root.addWidget(self.tabs)

        dashboard_page = QWidget()
        dash = QVBoxLayout(dashboard_page)
        dash.setSpacing(12)
        self.monitor = MonitorDashboard()
        dash.addWidget(self.monitor)
        dash.addWidget(self._build_action_section())

        scroll = _VerticalScrollArea(dashboard_page)
        self.tabs.addTab(scroll, "메인")
        self.odds_log_panel = OddsLogPanel(self._odds_log, self._store.logs_dir)
        self.tabs.addTab(self.odds_log_panel, "배당 로그")
        self.pipeline_overlay = PipelineDebugOverlay()
        self.x10_debug_panel = X10DebugPanel()
        self.bc_slip_debug_panel = BcSlipDebugPanel()
        self.bc_stake_debug_panel = BcStakeDebugPanel()
        debug_page = QWidget()
        debug_layout = QVBoxLayout(debug_page)
        debug_layout.addWidget(self.pipeline_overlay)
        debug_layout.addWidget(self.bc_slip_debug_panel)
        debug_layout.addWidget(self.bc_stake_debug_panel)
        debug_layout.addWidget(self.x10_debug_panel, 1)
        debug_scroll = _VerticalScrollArea(debug_page)
        self.tabs.addTab(debug_scroll, "Debug")

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.status.showMessage("Bridge 시작 중…")

        self._thread = QThread()
        self._worker = BridgeWorker(self._store, app_settings=self._settings)
        self._worker.attach_odds_log(self._odds_log)
        self._worker.moveToThread(self._thread)
        # bootstrap is invoked from start_background_services(), not thread.started
        self._worker.ready.connect(self._on_bridge_ready)
        self._worker.error.connect(self._on_error)
        self._worker.bridge_status.connect(self._on_bridge_status)
        self._worker.slip_updated.connect(self._on_slip_updated)
        self._worker.x10_debug.connect(self._on_x10_debug)
        self._worker.watch_state.connect(self._on_watch_state)
        self._worker.live_metrics.connect(self._on_live_metrics)
        self._worker.fx_updated.connect(self._on_fx_updated)
        self._worker.execution_update.connect(self._on_execution_update)
        self._worker.bc_stake_debug.connect(self._on_bc_stake_debug)
        self._worker.bc_slip_debug.connect(self._on_bc_slip_debug)
        self._worker.pipeline_overlay_updated.connect(self._on_pipeline_overlay)
        self.pipeline_overlay.rescan_x10_requested.connect(self._on_rescan_x10)
        self.pipeline_overlay.rescan_bc_requested.connect(self._on_rescan_bc)
        self.pipeline_overlay.bc_stake_scan_requested.connect(self._worker.scan_bc_stake)
        self.pipeline_overlay.bc_stake_test_requested.connect(lambda: self._worker.test_bc_stake(1.0))
        self.pipeline_overlay.x10_bet_button_requested.connect(self._worker.scan_x10_bet_button)
        self.pipeline_overlay.bc_bet_button_requested.connect(self._worker.scan_bc_bet_button)
        self.pipeline_overlay.dry_run_dispatch_requested.connect(self._on_dry_run_dispatch)
        self._worker.log_message.connect(self._on_worker_log)
        self.bc_stake_debug_panel.test_requested.connect(self._worker.test_bc_stake)
        self.bc_stake_debug_panel.scan_requested.connect(self._worker.scan_bc_stake)
        self.bc_stake_debug_panel.x10_bet_button_requested.connect(self._worker.scan_x10_bet_button)
        self.bc_stake_debug_panel.bc_bet_button_requested.connect(self._worker.scan_bc_bet_button)

        self._wire_buttons()
        self._apply_watch_ui()
        self._refresh_settings_labels()
        self._background_started = False

    def start_background_services(self) -> None:
        """Start Bridge/FX/Scanner after the window is visible (never from __init__)."""
        if self._background_started:
            return
        self._background_started = True
        from arb_desktop.startup_crash import STARTUP_06, log_thread, startup_log

        log_thread("MAIN")
        startup_log(STARTUP_06)
        if not self._thread.isRunning():
            self._thread.started.connect(self._worker.bootstrap)
            self._thread.start()

    def schedule_post_show_tasks(self) -> None:
        """Deferred non-blocking tasks — no modal wizard during startup."""
        if not self._settings.setup_completed:
            self.status.showMessage("첫 실행 — 페어링 버튼으로 Chrome Bridge를 연결하세요")

    def _build_action_section(self) -> QWidget:
        box = QWidget()
        box.setProperty("class", "action-panel")
        layout = QVBoxLayout(box)
        layout.setSpacing(10)

        sync_row = QHBoxLayout()
        self.lbl_stake_sync = QLabel("BC 금액 자동동기화 ● ON")
        self.lbl_stake_sync.setProperty("class", "watch-on")
        sync_row.addWidget(self.lbl_stake_sync)
        sync_row.addStretch()
        layout.addLayout(sync_row)

        self.chk_confirm = QCheckBox("양쪽 카트가 서로 반대 선택임을 확인했습니다")
        layout.addWidget(self.chk_confirm)

        row = QHBoxLayout()
        row.setSpacing(10)
        self.btn_watch_start = QPushButton("자동감시 시작")
        self.btn_watch_start.setProperty("class", "primary")
        self.btn_watch_start.setMinimumHeight(48)
        self.btn_watch_stop = QPushButton("중지")
        self.btn_watch_stop.setEnabled(False)
        self.btn_watch_stop.setProperty("class", "danger-outline")
        self.btn_watch_stop.setMinimumHeight(48)
        self.btn_manual = QPushButton("⚡ 양쪽 즉시배팅")
        self.btn_manual.setProperty("class", "manual-bet")
        self.btn_manual.setMinimumHeight(50)
        self.btn_settings = QPushButton("설정")
        self.btn_repair = QPushButton("페어링")
        self.btn_reset_conn = QPushButton("초기화")
        self.btn_reconnect = QPushButton("연결 확인")
        self.btn_log = QPushButton("로그")
        self.btn_quit = QPushButton("종료")
        for btn in (
            self.btn_watch_start,
            self.btn_watch_stop,
            self.btn_manual,
            self.btn_settings,
            self.btn_repair,
            self.btn_reset_conn,
            self.btn_reconnect,
            self.btn_log,
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
        self.btn_manual.clicked.connect(self._manual_bet)
        self.btn_settings.clicked.connect(self._open_settings)
        self.btn_log.clicked.connect(self._open_log_window)
        self.btn_quit.clicked.connect(self.close)
        self.chk_confirm.toggled.connect(self._on_confirm_toggled)

    def _apply_watch_ui(self) -> None:
        if self._watch_enabled_ui:
            self.btn_watch_start.setText("● 자동감시 실행 중")
            self.btn_watch_start.setEnabled(False)
            self.btn_watch_start.setProperty("class", "watch-on")
            self.btn_watch_stop.setEnabled(True)
        else:
            self.btn_watch_start.setText("자동감시 시작")
            self.btn_watch_start.setEnabled(not self._partial_locked)
            self.btn_watch_start.setProperty("class", "primary")
            self.btn_watch_stop.setEnabled(False)
        self.btn_manual.setEnabled(not self._partial_locked)
        for btn in (self.btn_watch_start, self.btn_manual):
            btn.style().unpolish(btn)
            btn.style().polish(btn)

    def _metrics_with_watch(self, m: WatchMetrics) -> WatchMetrics:
        m.watch_enabled = self._watch_enabled_ui
        if self._watch_enabled_ui and self._watch_started_at:
            m.watch_started_at = self._watch_started_at
        m.stake_sync_enabled = self._settings.stake_sync_enabled
        return m

    def _refresh_settings_labels(self) -> None:
        s = self._settings
        on = "ON" if s.stake_sync_enabled else "OFF"
        css = "watch-on" if s.stake_sync_enabled else "watch-off"
        self.lbl_stake_sync.setText(f"BC 금액 자동동기화 ● {on}")
        self.lbl_stake_sync.setProperty("class", css)
        self.lbl_stake_sync.style().unpolish(self.lbl_stake_sync)
        self.lbl_stake_sync.style().polish(self.lbl_stake_sync)
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
        self.status.showMessage("Bridge 실행 중 — 시세 감시 준비됨")

    def _on_bridge_status(self, status: BridgeStatus) -> None:
        if status.bridge == BridgeConnectionState.CONNECTED:
            self.status.showMessage("Chrome Bridge 연결됨")

    def _on_slip_updated(self, site: str, read) -> None:
        if site == "bti" and getattr(read, "raw", None):
            self.x10_debug_panel.update_from_slip_raw(read.raw)
        if site == "bc" and getattr(read, "raw", None):
            self.bc_slip_debug_panel.update_from_payload(read.raw)
        self._request_metrics_refresh()

    def _on_fx_updated(self, snap) -> None:
        self._refresh_settings_labels()

    def _on_live_metrics(self, m: WatchMetrics) -> None:
        m = self._metrics_with_watch(m)
        state = self._current_state if self._watch_enabled_ui else "IDLE"
        self.monitor.update_all(m, state=state)
        if m.x10_parse_debug:
            self.x10_debug_panel.update_parse_debug(m.x10_parse_debug)

    def _on_pipeline_overlay(self, payload: dict) -> None:
        self.pipeline_overlay.update_payload(payload)
        self.monitor.update_pipeline_overlay(payload)

    def _on_dry_run_dispatch(self) -> None:
        self.pipeline_overlay.set_action_result("Dry-run dispatch 요청…")
        self._worker.dry_run_dispatch()

    def _on_rescan_x10(self) -> None:
        self.pipeline_overlay.set_action_result("X10 재스캔 요청…")
        self._worker.force_rescan_x10()

    def _on_rescan_bc(self) -> None:
        self.pipeline_overlay.set_action_result("BC 재스캔 요청…")
        self._worker.force_rescan_bc()

    def _on_bc_slip_debug(self, payload: dict) -> None:
        self.bc_slip_debug_panel.update_from_payload(payload)
        if payload.get("site_state"):
            self.bc_slip_debug_panel.update_site_state(payload.get("site_state"))

    def _on_bc_stake_debug(self, payload: dict) -> None:
        self.bc_stake_debug_panel.update_from_payload(payload)
        block = str(payload.get("block") or "")
        if block in {"BET BUTTON SCAN", "BET BUTTON FOUND", "BET BUTTON FAILED", "BC BET BUTTON", "X10 BET BUTTON"}:
            x10_ok = bool(payload.get("x10_found") or (payload.get("site") == "x10" and payload.get("ok")))
            bc_ok = bool(payload.get("bc_found") or (payload.get("site") == "bc" and payload.get("ok")))
            if payload.get("site") == "x10":
                self.pipeline_overlay.set_action_result(
                    f"X10 BET BUTTON = {'PASS' if payload.get('ok') else 'FAIL'}\n{payload.get('reason', '')}",
                    ok=bool(payload.get("ok")),
                )
            elif payload.get("site") == "bc" and "BET BUTTON" in block:
                self.pipeline_overlay.set_action_result(
                    f"BC BET BUTTON = {'PASS' if payload.get('ok') else 'FAIL'}\n{payload.get('reason', '')}",
                    ok=bool(payload.get("ok")),
                )
            elif block == "BET BUTTON SCAN":
                self.pipeline_overlay.set_action_result(
                    f"X10 BET BUTTON = {'PASS' if x10_ok else 'FAIL'}\n"
                    f"BC BET BUTTON = {'PASS' if bc_ok else 'FAIL'}",
                    ok=x10_ok and bc_ok,
                )
        if payload.get("block") == "BC STAKE TEST":
            self.bc_stake_debug_panel.set_test_result(
                ok=bool(payload.get("success")),
                actual=payload.get("actual"),
                reason=str(payload.get("reason") or ""),
            )
            self.pipeline_overlay.set_action_result(
                f"BC STAKE TEST = {'PASS' if payload.get('success') else 'FAIL'}\n"
                f"actual={payload.get('actual')} reason={payload.get('reason', '')}",
                ok=bool(payload.get("success")),
            )

    def _on_execution_update(self, state) -> None:
        m = self._metrics_with_watch(self._worker.watch_metrics)
        phase = getattr(state, "phase", None)
        if phase and hasattr(phase, "value"):
            m.execution_phase = phase.value
            m.execution_message = getattr(state, "message", "")
            m.dispatch_gap_ms = getattr(state, "dispatch_gap_ms", 0.0)
        result = getattr(state, "last_result", None)
        msg = m.execution_message or ""
        if result and getattr(result, "partial", False):
            self._partial_locked = True
            self._stop_watch()
            self._apply_watch_ui()
            self.monitor.update_all(m, state="PARTIAL BET", message="일부 배팅 성공 — 즉시 확인 필요")
            self.status.showMessage("PARTIAL BET — 재실행 금지")
            return
        if result and getattr(result, "abort_reason", ""):
            self.status.showMessage(f"배팅 취소: {msg}")
        elif msg:
            self.status.showMessage(msg)
        if phase and hasattr(phase, "value") and phase.value in {"SUCCESS", "DISPATCH"}:
            state_name = "SUCCESS" if phase.value == "SUCCESS" else self._current_state
        elif result and getattr(result, "outcome", None) and str(getattr(result.outcome, "value", "")) == "DRY_RUN_MOCK":
            state_name = "SUCCESS"
        else:
            state_name = self._current_state
        self.monitor.update_all(m, state=state_name, message=msg)

    def _on_confirm_toggled(self, checked: bool) -> None:
        self._worker.set_user_confirmed(checked)

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
        if self._log_window:
            self._log_window.append(entry.timestamp, entry.site, entry.status, entry.odds, entry.profit, entry.message)

    def _on_error(self, msg: str) -> None:
        if msg.startswith("Bridge ERROR") or msg.startswith("FX ERROR"):
            self.status.showMessage(msg)
        else:
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
        self._worker.start_watch()
        self.status.showMessage("자동감시 ON — 실시간 조건 감시 중")

    def _stop_watch(self) -> None:
        self._watch_enabled_ui = False
        self._watch_started_at = ""
        self._current_state = "IDLE"
        self._apply_watch_ui()
        self._worker.stop_watch()
        m = self._metrics_with_watch(self._worker.watch_metrics)
        self.monitor.update_all(m, state="IDLE", message="감시 중지됨")
        self.status.showMessage("자동감시 OFF")

    def _manual_bet(self) -> None:
        if self._partial_locked:
            self.status.showMessage("PARTIAL BET — 확인 후 앱을 재시작하세요")
            return
        if not self._worker.bridge_connected:
            self.status.showMessage("Bridge 연결 필요")
            return
        if not self.chk_confirm.isChecked():
            self.status.showMessage("반대 선택 확인이 필요합니다")
            return

        if not self._settings.live_execution_enabled:
            self.status.showMessage("Live Execution OFF — 설정에서 Live Execution을 켜세요")
            return

        m = self._metrics_with_watch(self._worker.watch_metrics)
        live = self._settings.live_execution_enabled
        below = m.total_stake_krw > 0 and m.current_profit_rate < m.target_profit_pct
        skip_confirm = self._settings.manual_confirm_skip

        if below:
            dlg = ManualBetDialog(m, live=live, below_target=True, parent=self)
            if dlg.exec() != dlg.DialogCode.Accepted:
                return
            skip_target = dlg.proceed_anyway
        elif live and not skip_confirm:
            dlg = ManualBetDialog(m, live=True, below_target=False, parent=self)
            if dlg.exec() != dlg.DialogCode.Accepted:
                return
            skip_target = False
        elif not live and not skip_confirm:
            dlg = ManualBetDialog(m, live=False, below_target=False, parent=self)
            if dlg.exec() != dlg.DialogCode.Accepted:
                return
            skip_target = False
        else:
            skip_target = below

        self.btn_manual.setEnabled(False)
        self.status.showMessage("양쪽 병렬 배팅 준비 중…")
        self._worker.manual_bet(skip_target_check=skip_target or below)
        QTimer.singleShot(3000, lambda: self.btn_manual.setEnabled(not self._partial_locked))

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
        if self._thread.isRunning():
            self._thread.quit()
            self._thread.wait(500)
        super().closeEvent(event)


def run_app(
    *,
    preloaded_store: SettingsStore | None = None,
    preloaded_settings: AppSettings | None = None,
) -> int:
    from arb_desktop.startup_crash import (
        STARTUP_01,
        STARTUP_03,
        STARTUP_04,
        STARTUP_05,
        record_crash,
        show_crash_dialog,
        startup_log,
    )

    try:
        lock = ensure_single_instance()
        if not lock.ok:
            startup_log(f"{STARTUP_01} warning: {lock.message} — GUI will start anyway")

        startup_log(STARTUP_01)
        QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
        app = QApplication(sys.argv)
        app.setApplicationName("arb-desktop")
        app.setStyle("Fusion")

        store = preloaded_store or SettingsStore()
        settings = preloaded_settings or store.load()
        if preloaded_store is None:
            try:
                store.apply_to_runtime(settings)
            except Exception as exc:
                startup_log(f"{STARTUP_01} apply_to_runtime warning: {exc}")
        apply_theme(app, settings.ui_theme)

        startup_log(STARTUP_03)
        win = MainWindow(store=store, settings=settings)

        startup_log(STARTUP_04)
        from arb_desktop.startup_crash import log_thread

        log_thread("MAIN")
        win.show()
        app.processEvents()
        if not lock.ok:
            win.status.showMessage(f"경고: {lock.message}")
        QTimer.singleShot(0, win.start_background_services)
        QTimer.singleShot(0, win.schedule_post_show_tasks)
        QTimer.singleShot(250, lambda: startup_log(STARTUP_05))
        return app.exec()
    except BaseException as exc:
        import sys as _sys

        log_path = record_crash(exc, stage="run_app", tb=_sys.exc_info()[2])
        show_crash_dialog(exc, log_path, stage="run_app")
        return 1
