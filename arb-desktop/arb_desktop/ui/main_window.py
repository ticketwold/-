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
    QComboBox,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QDoubleSpinBox,
    QStatusBar,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from arb_desktop.bridge.instance_lock import ensure_single_instance
from arb_desktop.bridge.message_models import BridgeConnectionState, BridgeStatus
from arb_desktop.ui.bridge_worker import BridgeWorker
from arb_desktop.ui.log_manager import LogManager
from arb_desktop.ui.log_window import LogWindow
from arb_desktop.ui.settings_store import AppSettings, SettingsStore
from arb_desktop.ui.setup_wizard import SetupWizard
from arb_desktop.ui.watch_engine import WatchMetrics
from arb_desktop.ui.x10_debug_panel import X10DebugPanel


def _chrome_bridge_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "chrome-bridge"  # type: ignore[attr-defined]
    return Path(__file__).resolve().parents[3] / "chrome-bridge"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("arb-desktop — 양방 배팅 데스크톱")
        self.resize(900, 680)

        self._store = SettingsStore()
        self._settings = self._store.load()
        self._store.apply_to_runtime(self._settings)

        self._log_window: LogWindow | None = None
        self._log = LogManager(self._store.logs_dir, on_entry=self._on_log_entry)

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        self.tabs = QTabWidget()
        root.addWidget(self.tabs)

        dashboard = QWidget()
        dashboard_layout = QVBoxLayout(dashboard)
        dashboard_layout.addWidget(self._build_connection_group())
        dashboard_layout.addWidget(self._build_settings_group())
        dashboard_layout.addWidget(self._build_live_group())
        dashboard_layout.addWidget(self._build_state_group())
        dashboard_layout.addWidget(self._build_buttons_group())
        dashboard_layout.addWidget(self._build_log_preview())
        self.tabs.addTab(dashboard, "메인")

        self.x10_debug_panel = X10DebugPanel()
        self.tabs.addTab(self.x10_debug_panel, "Debug (x10)")

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.status.showMessage("Bridge 서버 시작 중…")

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
        self._load_settings_to_ui()
        self._thread.start()

        if not self._settings.setup_completed:
            self._run_setup_wizard()

    def _build_connection_group(self) -> QGroupBox:
        box = QGroupBox("연결 상태")
        grid = QGridLayout(box)
        font = QFont("Consolas", 10)
        self.lbl_bridge = QLabel("Chrome Bridge: WAITING")
        self.lbl_extension = QLabel("확장: 미연결")
        self.lbl_last_connected = QLabel("마지막 연결: —")
        self.lbl_bc_tab = QLabel("BC.Game 탭: NOT FOUND")
        self.lbl_x10_tab = QLabel("x10x10s 탭: NOT FOUND")
        self.lbl_bc_slip = QLabel("BC BetSlip: EMPTY")
        self.lbl_x10_slip = QLabel("x10 BetSlip: EMPTY")
        for i, lbl in enumerate(
            [
                self.lbl_bridge,
                self.lbl_extension,
                self.lbl_last_connected,
                self.lbl_bc_tab,
                self.lbl_x10_tab,
                self.lbl_bc_slip,
                self.lbl_x10_slip,
            ]
        ):
            lbl.setFont(font)
            grid.addWidget(lbl, i, 0)

        btn_row = QHBoxLayout()
        self.btn_repair = QPushButton("다시 페어링")
        self.btn_reset_conn = QPushButton("연결 초기화")
        btn_row.addWidget(self.btn_repair)
        btn_row.addWidget(self.btn_reset_conn)
        grid.addLayout(btn_row, 7, 0)
        return box

    def _build_settings_group(self) -> QGroupBox:
        box = QGroupBox("사용자 설정")
        form = QFormLayout(box)
        self.spin_target = QDoubleSpinBox()
        self.spin_target.setRange(0, 50)
        self.spin_target.setSuffix(" %")
        self.spin_bti_stake = QSpinBox()
        self.spin_bti_stake.setRange(1000, 50_000_000)
        self.spin_bti_stake.setSuffix(" KRW")
        self.lbl_fx_rate = QLabel("—")
        self.lbl_fx_rate.setFont(QFont("Consolas", 10))
        self.lbl_fx_source = QLabel("출처: 빗썸 KRW-USDT")
        self.lbl_fx_status = QLabel("상태: LOADING")
        self.lbl_fx_updated = QLabel("마지막 갱신: —")
        self.chk_fx_auto = QCheckBox("빗썸 자동 환율 사용")
        self.chk_fx_auto.setChecked(True)
        self.spin_fx_refresh = QDoubleSpinBox()
        self.spin_fx_refresh.setRange(1, 60)
        self.spin_fx_refresh.setSuffix(" s")
        self.spin_fx_stale = QDoubleSpinBox()
        self.spin_fx_stale.setRange(5, 120)
        self.spin_fx_stale.setSuffix(" s")
        self.combo_round_krw = QComboBox()
        self.combo_round_krw.addItems(["100", "500", "1000", "10000"])
        self.combo_round_usdt = QComboBox()
        self.combo_round_usdt.addItems(["0.1", "0.01", "1.0"])
        self.spin_stabilize = QDoubleSpinBox()
        self.spin_stabilize.setRange(0.5, 60)
        self.spin_stabilize.setSuffix(" s")
        self.spin_stable_count = QSpinBox()
        self.spin_stable_count.setRange(1, 20)
        self.chk_dry = QCheckBox("드라이런 (실제 배팅 안 함)")
        self.chk_dry.setChecked(True)
        self.chk_confirm = QCheckBox("양쪽 카트가 서로 반대 선택임을 직접 확인했습니다")
        form.addRow("목표 수익률", self.spin_target)
        form.addRow("텐텐벳 배팅금액", self.spin_bti_stake)
        form.addRow("USDT/KRW 환율", self.lbl_fx_rate)
        form.addRow("", self.lbl_fx_source)
        form.addRow("", self.lbl_fx_status)
        form.addRow("", self.lbl_fx_updated)
        form.addRow(self.chk_fx_auto)
        form.addRow("환율 갱신 주기", self.spin_fx_refresh)
        form.addRow("최대 허용 지연", self.spin_fx_stale)
        form.addRow("원화 반올림 단위", self.combo_round_krw)
        form.addRow("USDT 반올림 단위", self.combo_round_usdt)
        form.addRow("배당 안정화 시간", self.spin_stabilize)
        form.addRow("연속 동일 배당 확인", self.spin_stable_count)
        form.addRow(self.chk_dry)
        form.addRow(self.chk_confirm)
        return box

    def _build_live_group(self) -> QGroupBox:
        box = QGroupBox("실시간 값")
        grid = QGridLayout(box)
        labels = [
            ("텐텐벳 현재 배당", "lbl_bti_odds"),
            ("BC.Game 현재 배당", "lbl_bc_odds"),
            ("BC 자동 계산 금액", "lbl_bc_stake"),
            ("BC 원화 환산 금액", "lbl_bc_stake_krw"),
            ("총 배팅금", "lbl_total_stake"),
            ("텐텐벳 적중 시 수익", "lbl_profit_x10"),
            ("BC 적중 시 수익", "lbl_profit_bc"),
            ("최저 보장 수익", "lbl_min_profit"),
            ("텐텐벳 결과 수익률", "lbl_rate_x10"),
            ("BC 결과 수익률", "lbl_rate_bc"),
            ("현재 최저 보장 수익률", "lbl_current_rate"),
            ("목표 수익률", "lbl_target_rate"),
            ("목표까지", "lbl_target_delta"),
        ]
        for row, (title, attr) in enumerate(labels):
            grid.addWidget(QLabel(title), row, 0)
            lbl = QLabel("—")
            lbl.setFont(QFont("Consolas", 10))
            setattr(self, attr, lbl)
            grid.addWidget(lbl, row, 1)
        return box

    def _build_state_group(self) -> QGroupBox:
        box = QGroupBox("상태")
        layout = QVBoxLayout(box)
        self.lbl_engine_state = QLabel("IDLE")
        self.lbl_engine_state.setFont(QFont("Consolas", 14, QFont.Weight.Bold))
        self.lbl_engine_msg = QLabel("")
        layout.addWidget(self.lbl_engine_state)
        layout.addWidget(self.lbl_engine_msg)
        return box

    def _build_buttons_group(self) -> QWidget:
        w = QWidget()
        row = QHBoxLayout(w)
        self.btn_reconnect = QPushButton("연결 다시 확인")
        self.btn_watch_start = QPushButton("자동감시 시작")
        self.btn_watch_stop = QPushButton("자동감시 중지")
        self.btn_watch_stop.setEnabled(False)
        self.btn_dry_test = QPushButton("드라이런 테스트")
        self.btn_save = QPushButton("설정 저장")
        self.btn_log = QPushButton("로그 열기")
        self.btn_quit = QPushButton("프로그램 종료")
        for btn in (
            self.btn_reconnect,
            self.btn_watch_start,
            self.btn_watch_stop,
            self.btn_dry_test,
            self.btn_save,
            self.btn_log,
            self.btn_quit,
        ):
            row.addWidget(btn)
        return w

    def _build_log_preview(self) -> QGroupBox:
        box = QGroupBox("최근 로그")
        layout = QVBoxLayout(box)
        self.lbl_last_log = QLabel("—")
        self.lbl_last_log.setFont(QFont("Consolas", 9))
        self.lbl_last_log.setWordWrap(True)
        layout.addWidget(self.lbl_last_log)
        return box

    def _wire_buttons(self) -> None:
        self.btn_reconnect.clicked.connect(self._worker.reconnect)
        self.btn_repair.clicked.connect(self._worker.repair_pairing)
        self.btn_reset_conn.clicked.connect(self._on_reset_connection)
        self.btn_watch_start.clicked.connect(self._start_watch)
        self.btn_watch_stop.clicked.connect(self._stop_watch)
        self.btn_dry_test.clicked.connect(self._dry_run_test)
        self.btn_save.clicked.connect(self._save_settings)
        self.btn_log.clicked.connect(self._open_log_window)
        self.btn_quit.clicked.connect(self.close)
        self.spin_target.valueChanged.connect(self._request_metrics_refresh)
        self.spin_bti_stake.valueChanged.connect(self._request_metrics_refresh)
        self.chk_confirm.toggled.connect(self._on_confirm_toggled)

    def _load_settings_to_ui(self) -> None:
        s = self._settings
        self.spin_target.setValue(s.target_profit_pct)
        self.spin_bti_stake.setValue(s.bti_stake_krw)
        self.chk_fx_auto.setChecked(s.fx_auto_enabled)
        self.spin_fx_refresh.setValue(s.fx_refresh_seconds)
        self.spin_fx_stale.setValue(s.fx_max_stale_seconds)
        self.spin_stabilize.setValue(s.stabilize_seconds)
        self.spin_stable_count.setValue(s.stable_count_required)
        self.chk_dry.setChecked(s.dry_run)
        self._set_combo_value(self.combo_round_krw, str(s.round_unit_krw))
        self._set_combo_value(self.combo_round_usdt, str(s.round_unit_usdt))
        self._on_confirm_toggled(self.chk_confirm.isChecked())

    def _on_reset_connection(self) -> None:
        reply = QMessageBox.question(
            self,
            "연결 초기화",
            "페어링 credential을 재발급합니다.\n확장 프로그램은 자동으로 다시 페어링됩니다.",
        )
        if reply == QMessageBox.StandardButton.Yes:
            self._worker.reset_connection()
            self.status.showMessage("연결 초기화됨 — 확장 자동 재페어링 대기")

    def _set_combo_value(self, combo: QComboBox, value: str) -> None:
        idx = combo.findText(value)
        if idx >= 0:
            combo.setCurrentIndex(idx)

    def _collect_settings(self) -> AppSettings:
        s = self._settings
        s.target_profit_pct = self.spin_target.value()
        s.bti_stake_krw = self.spin_bti_stake.value()
        s.fx_auto_enabled = self.chk_fx_auto.isChecked()
        s.fx_refresh_seconds = self.spin_fx_refresh.value()
        s.fx_max_stale_seconds = self.spin_fx_stale.value()
        s.stabilize_seconds = self.spin_stabilize.value()
        s.stable_count_required = self.spin_stable_count.value()
        s.dry_run = self.chk_dry.isChecked()
        s.round_unit_krw = int(self.combo_round_krw.currentText())
        s.round_unit_usdt = float(self.combo_round_usdt.currentText())
        return s

    def _save_settings(self) -> None:
        self._settings = self._collect_settings()
        self._store.save(self._settings)
        self._worker.update_settings(self._settings)
        self.status.showMessage("설정 저장됨")
        self._log.log(site="APP", status="SAVE", message="settings saved")

    def _run_setup_wizard(self) -> None:
        wizard = SetupWizard(self)
        if wizard.exec():
            self._settings.setup_completed = True
            self._store.save(self._settings)

    def _on_bridge_ready(self) -> None:
        self.status.showMessage("Bridge 서버 실행 중 — 확장 자동 연결 대기")
        self.btn_watch_start.setEnabled(True)

    def _on_bridge_status(self, status: BridgeStatus) -> None:
        bridge_line = status.format_lines()[0]
        self.lbl_bridge.setText(bridge_line.replace("BC.Game tab", "BC.Game 탭").replace("x10x10s tab", "x10x10s 탭"))

        if status.extension_id:
            short = f"{status.extension_id[:8]}…" if len(status.extension_id) > 10 else status.extension_id
            self.lbl_extension.setText(f"확장: {short}")
        else:
            self.lbl_extension.setText("확장: 미연결")

        self.lbl_last_connected.setText(
            f"마지막 연결: {status.last_connected_at}" if status.last_connected_at else "마지막 연결: —"
        )

        slip_labels = [self.lbl_bc_tab, self.lbl_x10_tab, self.lbl_bc_slip, self.lbl_x10_slip]
        for lbl, line in zip(slip_labels, status.format_lines()[1:5], strict=True):
            lbl.setText(line.replace("BC.Game tab", "BC.Game 탭").replace("x10x10s tab", "x10x10s 탭"))

        if status.bridge == BridgeConnectionState.CONNECTED:
            self.status.showMessage("Chrome Bridge 연결됨")
        elif status.bridge == BridgeConnectionState.AUTH_FAILED:
            self.status.showMessage("Chrome Bridge 인증 실패 — 확장을 다시 로드하거나 '다시 페어링'을 사용하세요")
        else:
            self.status.showMessage("Chrome Bridge 연결 대기 중…")

    def _on_slip_updated(self, site: str, read) -> None:
        if site == "bti" and getattr(read, "raw", None):
            self.x10_debug_panel.update_from_slip_raw(read.raw)
        self._request_metrics_refresh()

    def _on_fx_updated(self, snap) -> None:
        if snap.rate:
            self.lbl_fx_rate.setText(f"{snap.rate:,.2f}원")
        status = str(snap.status.value).replace("fx-", "").upper()
        self.lbl_fx_status.setText(f"상태: {status}")
        if snap.updated_at:
            from datetime import datetime
            self.lbl_fx_updated.setText(
                f"마지막 갱신: {datetime.fromtimestamp(snap.updated_at).strftime('%H:%M:%S')}"
            )

    def _on_live_metrics(self, m: WatchMetrics) -> None:
        self._apply_metrics(m)

    def _on_confirm_toggled(self, checked: bool) -> None:
        self._worker.set_user_confirmed(checked)
        self._request_metrics_refresh()

    def _on_x10_debug(self, payload: dict) -> None:
        self.x10_debug_panel.update_from_payload(payload)

    def _on_watch_state(self, state: str, metrics: WatchMetrics, message: str) -> None:
        self.lbl_engine_state.setText(state)
        self.lbl_engine_msg.setText(message)
        self._apply_metrics(metrics)

    def _on_worker_log(self, site: str, status: str, odds: str, profit: str, message: str, dedup: str) -> None:
        self._log.log(site=site, status=status, odds=odds, profit=profit, message=message, dedup_key=dedup)

    def _on_log_entry(self, entry) -> None:
        line = entry.format_line()
        self.lbl_last_log.setText(line)
        if self._log_window:
            self._log_window.append(entry.timestamp, entry.site, entry.status, entry.odds, entry.profit, entry.message)

    def _on_error(self, msg: str) -> None:
        self.status.showMessage(f"오류: {msg}")
        self._log.log(site="APP", status="ERROR", message=msg)

    def _apply_metrics(self, m: WatchMetrics) -> None:
        self.lbl_bti_odds.setText(f"{m.bti_odds:.3f}" if m.bti_odds else "—")
        self.lbl_bc_odds.setText(f"{m.bc_odds:.3f}" if m.bc_odds else "—")
        self.lbl_bc_stake.setText(f"{m.bc_stake_usdt:.1f} USDT" if m.bc_stake_usdt else "—")
        self.lbl_bc_stake_krw.setText(f"{m.bc_stake_krw:,.0f} KRW" if m.bc_stake_krw else "—")
        self.lbl_total_stake.setText(f"{m.total_stake_krw:,.0f} KRW" if m.total_stake_krw else "—")
        self.lbl_profit_x10.setText(f"{m.profit_x10_krw:,.0f} KRW" if m.total_stake_krw else "—")
        self.lbl_profit_bc.setText(f"{m.profit_bc_krw:,.0f} KRW" if m.total_stake_krw else "—")
        self.lbl_min_profit.setText(f"{m.min_guaranteed_profit_krw:,.0f} KRW" if m.total_stake_krw else "—")
        self.lbl_rate_x10.setText(f"{m.profit_rate_x10:.2f} %" if m.total_stake_krw else "—")
        self.lbl_rate_bc.setText(f"{m.profit_rate_bc:.2f} %" if m.total_stake_krw else "—")
        self.lbl_target_rate.setText(f"{m.target_profit_pct:.2f} %")
        if m.total_stake_krw:
            rate_text = f"{m.current_profit_rate:.2f} %"
            if m.current_profit_rate < 0:
                self.lbl_current_rate.setStyleSheet("color: #c0392b; font-weight: bold;")
            elif m.current_profit_rate >= m.target_profit_pct:
                self.lbl_current_rate.setStyleSheet("color: #27ae60; font-weight: bold;")
            else:
                self.lbl_current_rate.setStyleSheet("")
            self.lbl_current_rate.setText(rate_text)
            delta = m.target_delta_pct
            sign = "+" if delta >= 0 else ""
            self.lbl_target_delta.setText(f"{sign}{delta:.2f}%p")
        else:
            self.lbl_current_rate.setText("—")
            self.lbl_target_delta.setText("—")
            self.lbl_current_rate.setStyleSheet("")

    def _request_metrics_refresh(self) -> None:
        self._settings = self._collect_settings()
        self._worker.update_settings(self._settings)

    def _start_watch(self) -> None:
        if not self.chk_confirm.isChecked():
            self.status.showMessage("반대 선택 확인 체크박스를 선택하세요")
            return
        self._settings = self._collect_settings()
        self._worker.set_user_confirmed(True)
        self._worker.update_settings(self._settings)
        self._worker.start_watch()
        self.btn_watch_start.setEnabled(False)
        self.btn_watch_stop.setEnabled(True)
        self._log.log(site="APP", status="WATCH", message="auto watch started")

    def _stop_watch(self) -> None:
        self._worker.stop_watch()
        self.btn_watch_start.setEnabled(True)
        self.btn_watch_stop.setEnabled(False)
        self._log.log(site="APP", status="WATCH", message="auto watch stopped")

    def _dry_run_test(self) -> None:
        self._settings = self._collect_settings()
        self._worker.update_settings(self._settings)
        self._worker.start_watch()
        self.status.showMessage("드라이런 테스트 — READY 까지 감시 (Bet 클릭 없음)")

    def _open_log_window(self) -> None:
        if not self._log_window:
            self._log_window = LogWindow(self)
        self._log_window.show()
        self._log_window.raise_()
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

    app = QApplication(sys.argv)
    app.setApplicationName("arb-desktop")
    app.setStyle("Fusion")
    win = MainWindow()
    win.show()
    return app.exec()
