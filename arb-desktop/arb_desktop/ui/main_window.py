from __future__ import annotations

import asyncio
import sys
from typing import Any

from PyQt6.QtCore import QObject, QThread, pyqtSignal, pyqtSlot
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
    QDoubleSpinBox,
    QCheckBox,
    QStatusBar,
)

from arb_desktop.config import settings
from arb_desktop.engine.coordinator import Coordinator
from arb_desktop.models import EngineTick


class AsyncWorker(QObject):
    tick = pyqtSignal(object)
    status = pyqtSignal(str)
    error = pyqtSignal(str)
    ready = pyqtSignal()

    def __init__(self):
        super().__init__()
        self._coordinator: Coordinator | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    @pyqtSlot()
    def bootstrap(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._coordinator = Coordinator(on_tick=lambda t: self.tick.emit(t))
            self._loop.run_until_complete(self._coordinator.start())
            self.ready.emit()
            self._loop.run_forever()
        except Exception as exc:
            self.error.emit(str(exc))
        finally:
            if self._coordinator and self._loop:
                self._loop.run_until_complete(self._coordinator.stop())
            if self._loop:
                self._loop.close()

    @pyqtSlot()
    def start_scan(self) -> None:
        if self._coordinator:
            self._coordinator.start_loop()
            self.status.emit("스캔 시작")

    @pyqtSlot()
    def stop_scan(self) -> None:
        if self._coordinator:
            self._coordinator.stop_loop()
            self.status.emit("스캔 정지")

    @pyqtSlot(float, int)
    def update_settings(self, min_profit: float, bti_stake: int) -> None:
        if self._coordinator:
            self._coordinator.engine.min_profit_pct = min_profit
            self._coordinator.engine.bti_stake_krw = float(bti_stake)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("양방 배팅 데스크톱 v1.0.2 (BetSlip-first)")
        self.resize(1100, 720)

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)

        # Header metrics
        metrics = QHBoxLayout()
        self.lbl_bti = QLabel("텐텐뱃: —")
        self.lbl_bc = QLabel("BC.Game: —")
        self.lbl_latency = QLabel("감지: — ms | 계산: — ms | 틱: — ms")
        self.lbl_fx = QLabel(f"USDT/KRW: {settings.default_usdt_rate:,.0f}")
        for lbl in (self.lbl_bti, self.lbl_bc, self.lbl_latency, self.lbl_fx):
            lbl.setFont(QFont("Consolas", 10))
            metrics.addWidget(lbl)
        layout.addLayout(metrics)

        # Controls
        controls = QHBoxLayout()
        self.btn_start = QPushButton("스캔 시작")
        self.btn_stop = QPushButton("스캔 정지")
        self.btn_stop.setEnabled(False)
        self.spin_min_profit = QDoubleSpinBox()
        self.spin_min_profit.setRange(0, 50)
        self.spin_min_profit.setValue(settings.min_profit_pct)
        self.spin_min_profit.setSuffix(" %")
        self.spin_stake = QSpinBox()
        self.spin_stake.setRange(1000, 10_000_000)
        self.spin_stake.setValue(settings.default_bti_stake_krw)
        self.spin_stake.setSuffix(" KRW")
        self.chk_dry = QCheckBox("드라이런 (실제 배팅 안 함)")
        self.chk_dry.setChecked(True)

        controls.addWidget(QLabel("최소 수익"))
        controls.addWidget(self.spin_min_profit)
        controls.addWidget(QLabel("텐텐뱃 금액"))
        controls.addWidget(self.spin_stake)
        controls.addWidget(self.chk_dry)
        controls.addStretch()
        controls.addWidget(self.btn_start)
        controls.addWidget(self.btn_stop)
        layout.addLayout(controls)

        # Opportunities table
        self.table = QTableWidget(0, 9)
        self.table.setHorizontalHeaderLabels(
            ["경기", "BC팀", "BC배당", "텐텐쪽", "텐텐배당", "수익%", "BC USDT", "감지ms", "계산ms"]
        )
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.table)

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.status.showMessage("브라우저 초기화 중… (x10x10s + BC.Game 탭이 열립니다)")

        # Async worker thread
        self._thread = QThread()
        self._worker = AsyncWorker()
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.bootstrap)
        self._worker.ready.connect(self._on_ready)
        self._worker.tick.connect(self._on_tick)
        self._worker.status.connect(self.status.showMessage)
        self._worker.error.connect(self._on_error)

        self.btn_start.clicked.connect(self._start)
        self.btn_stop.clicked.connect(self._stop)
        self.spin_min_profit.valueChanged.connect(self._settings_changed)
        self.spin_stake.valueChanged.connect(self._settings_changed)

        self._thread.start()

    def _on_ready(self) -> None:
        self.status.showMessage("준비 완료 — 양쪽 사이트에 로그인 후 스캔 시작")
        self.btn_start.setEnabled(True)

    def _on_error(self, msg: str) -> None:
        self.status.showMessage(f"오류: {msg}")

    def _start(self) -> None:
        self._settings_changed()
        self._worker.start_scan()
        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)

    def _stop(self) -> None:
        self._worker.stop_scan()
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)

    def _settings_changed(self) -> None:
        self._worker.update_settings(self.spin_min_profit.value(), self.spin_stake.value())

    def _on_tick(self, tick: EngineTick) -> None:
        bti = tick.bti
        bc = tick.bc
        if tick.betslip:
            slip = tick.betslip
            self.lbl_bti.setText(
                f"텐텐뱃 카트: {slip.bti.first.selection if slip.bti.first else '비어있음'} "
                f"| {slip.bti.first.status.value if slip.bti.first else '-'}"
            )
            self.lbl_bc.setText(
                f"BC 카트: {slip.bc.first.selection if slip.bc.first else '비어있음'} "
                f"| {slip.bc.first.status.value if slip.bc.first else '-'}"
            )
        else:
            if bti:
                self.lbl_bti.setText(
                    f"텐텐뱃: {len(bti.matchups)}경기 | {bti.tier.value} | {bti.latency_ms:.1f}ms"
                )
            if bc:
                self.lbl_bc.setText(
                    f"BC: {len(bc.matchups)}경기 | {bc.tier.value} | {bc.latency_ms:.1f}ms"
                )
        self.lbl_latency.setText(
            f"감지: {max(bti.latency_ms if bti else 0, bc.latency_ms if bc else 0):.1f}ms "
            f"| 계산: {tick.calc_latency_ms:.1f}ms | 틱: {tick.tick_latency_ms:.1f}ms"
        )

        self.table.setRowCount(len(tick.opportunities))
        for row, opp in enumerate(tick.opportunities[:100]):
            vals = [
                f"{opp.home} vs {opp.away}",
                opp.bc_team,
                f"{opp.bc_odds:.3f}",
                opp.bti_side,
                f"{opp.bti_odds:.3f}",
                f"{opp.profit_pct:.2f}",
                f"{opp.bc_stake_usdt:.2f}",
                f"{opp.detection_ms:.1f}",
                f"{opp.calc_ms:.1f}",
            ]
            for col, val in enumerate(vals):
                self.table.setItem(row, col, QTableWidgetItem(val))

    def closeEvent(self, event) -> None:
        self._worker.stop_scan()
        self._thread.quit()
        self._thread.wait(3000)
        super().closeEvent(event)


def run_app() -> int:
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    win = MainWindow()
    win.show()
    return app.exec()
