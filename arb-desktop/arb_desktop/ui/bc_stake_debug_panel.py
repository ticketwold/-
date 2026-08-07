from __future__ import annotations

from typing import Any

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


class BcStakeDebugPanel(QWidget):
    """BC stake input locator / sync diagnostics."""

    scan_requested = pyqtSignal()
    test_requested = pyqtSignal(float)
    x10_bet_button_requested = pyqtSignal()
    bc_bet_button_requested = pyqtSignal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._mono = QFont("Consolas", 9)

        header_box = QGroupBox("BC Stake Input")
        header_form = QFormLayout(header_box)
        self.lbl_found = QLabel("—")
        self.lbl_selector = QLabel("—")
        self.lbl_frame_url = QLabel("—")
        self.lbl_current_value = QLabel("—")
        for lbl in (self.lbl_found, self.lbl_selector, self.lbl_frame_url, self.lbl_current_value):
            lbl.setFont(self._mono)
            lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            lbl.setWordWrap(True)
        header_form.addRow("상태", self.lbl_found)
        header_form.addRow("Selector", self.lbl_selector)
        header_form.addRow("Frame URL", self.lbl_frame_url)
        header_form.addRow("Current Value", self.lbl_current_value)

        btn_row = QHBoxLayout()
        self.btn_scan = QPushButton("BC Stake Input 찾기")
        self.btn_test = QPushButton("BC 1.0 USDT 입력 테스트")
        self.btn_x10_bet = QPushButton("X10 Bet 버튼 찾기")
        self.btn_bc_bet = QPushButton("BC Bet 버튼 찾기")
        self.btn_scan.setProperty("class", "primary")
        self.btn_test.setProperty("class", "primary")
        self.btn_x10_bet.setProperty("class", "primary")
        self.btn_bc_bet.setProperty("class", "primary")
        self.lbl_test_result = QLabel("—")
        self.lbl_test_result.setWordWrap(True)
        self.lbl_test_result.setFont(self._mono)
        btn_row.addWidget(self.btn_scan)
        btn_row.addWidget(self.btn_test)
        btn_row.addWidget(self.btn_x10_bet)
        btn_row.addWidget(self.btn_bc_bet)
        btn_row.addWidget(self.lbl_test_result, 1)
        self.btn_scan.clicked.connect(self._on_scan)
        self.btn_test.clicked.connect(self._on_test)
        self.btn_x10_bet.clicked.connect(self._on_x10_bet)
        self.btn_bc_bet.clicked.connect(self._on_bc_bet)

        scan_box = QGroupBox("[BC INPUT SCAN]")
        scan_layout = QVBoxLayout(scan_box)
        self.tbl_scan = QTableWidget(0, 9)
        self.tbl_scan.setHorizontalHeaderLabels(
            [
                "frame_url",
                "selector",
                "count",
                "placeholder",
                "type",
                "inputmode",
                "class",
                "value",
                "outerHTML",
            ]
        )
        self.tbl_scan.horizontalHeader().setStretchLastSection(True)
        self.tbl_scan.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.tbl_scan.setFont(self._mono)
        scan_layout.addWidget(self.tbl_scan)

        probe_box = QGroupBox("Input Probe (focus / disabled)")
        probe_layout = QVBoxLayout(probe_box)
        self.tbl_probe = QTableWidget(0, 8)
        self.tbl_probe.setHorizontalHeaderLabels(
            [
                "frame_url",
                "selector",
                "focus",
                "value",
                "placeholder",
                "disabled",
                "readonly",
                "aria-disabled",
            ]
        )
        self.tbl_probe.horizontalHeader().setStretchLastSection(True)
        self.tbl_probe.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.tbl_probe.setFont(self._mono)
        probe_layout.addWidget(self.tbl_probe)

        log_box = QGroupBox("Scan Log")
        log_layout = QVBoxLayout(log_box)
        self.txt_log = QTextEdit()
        self.txt_log.setReadOnly(True)
        self.txt_log.setFont(self._mono)
        self.txt_log.setMaximumHeight(140)
        log_layout.addWidget(self.txt_log)

        root = QVBoxLayout(self)
        root.addWidget(header_box)
        root.addLayout(btn_row)
        root.addWidget(scan_box, 1)
        root.addWidget(probe_box, 1)
        root.addWidget(log_box)

    def _on_scan(self) -> None:
        self.lbl_test_result.setText("스캔 중...")
        self.scan_requested.emit()

    def _on_test(self) -> None:
        self.lbl_test_result.setText("1.0 USDT 입력 테스트 중...")
        self.test_requested.emit(1.0)

    def _on_x10_bet(self) -> None:
        self.lbl_test_result.setText("X10 Bet 버튼 탐색 중...")
        self.x10_bet_button_requested.emit()

    def _on_bc_bet(self) -> None:
        self.lbl_test_result.setText("BC Bet 버튼 탐색 중...")
        self.bc_bet_button_requested.emit()

    def set_scan_status(self, *, scanning: bool) -> None:
        if scanning:
            self.lbl_test_result.setText("스캔 중...")

    def set_test_result(self, *, ok: bool, actual: float | None, reason: str) -> None:
        if ok:
            self.lbl_test_result.setText(f"SUCCESS\nactual={actual}")
            self.lbl_test_result.setProperty("class", "status-ok")
        else:
            self.lbl_test_result.setText(f"FAILED\nreason={reason}")
            self.lbl_test_result.setProperty("class", "status-bad")
        self.lbl_test_result.style().unpolish(self.lbl_test_result)
        self.lbl_test_result.style().polish(self.lbl_test_result)

    def update_from_payload(self, payload: dict[str, Any] | None) -> None:
        if not payload:
            return
        block = str(payload.get("block") or "").upper()
        debug = payload.get("debug") if isinstance(payload.get("debug"), dict) else payload

        found = payload.get("found")
        if found is None and debug.get("found") is not None:
            found = bool(debug.get("found"))
        if found is None:
            found = block in {"BC STAKE INPUT FOUND", "BC STAKE SYNC OK"} or bool(
                payload.get("selected_selector") or debug.get("selected_selector")
            )
        if block in {"BC STAKE INPUT NOT FOUND", "BC INPUT SCAN"} and not debug.get("found") and not payload.get("selector"):
            found = False

        self._set_found_status(bool(found))

        selector = (
            str(payload.get("selector") or "")
            or str(debug.get("selected_selector") or debug.get("selector") or "")
            or str((debug.get("found") or {}).get("selector") or "")
        )
        frame_url = (
            str(payload.get("frame_url") or "")
            or str(debug.get("frame_url") or "")
            or str((debug.get("found") or {}).get("frame_url") or "")
        )
        current_value = (
            payload.get("current_value")
            or debug.get("current_value")
            or debug.get("after_value")
            or payload.get("actual")
            or (debug.get("found") or {}).get("current_value")
        )
        self.lbl_selector.setText(selector or "—")
        self.lbl_frame_url.setText(frame_url or "—")
        self.lbl_current_value.setText(str(current_value) if current_value is not None else "—")

        scans = debug.get("scans") or payload.get("scans") or []
        if scans:
            self._fill_scan_table(scans)

        candidates = debug.get("input_candidates") or payload.get("input_candidates") or []
        if candidates:
            self._fill_probe_table(candidates)

        scan_lines = debug.get("scan_lines") or payload.get("scan_lines") or []
        for line in scan_lines:
            if line and line not in self.txt_log.toPlainText():
                self.txt_log.append(str(line))

        if block == "BC STAKE TEST":
            self.set_test_result(
                ok=bool(payload.get("success")),
                actual=payload.get("actual"),
                reason=str(payload.get("reason") or ""),
            )
        elif block == "BET BUTTON SCAN":
            x10 = "OK" if payload.get("x10_found") else "FAIL"
            bc = "OK" if payload.get("bc_found") else "FAIL"
            self.lbl_test_result.setText(f"X10 Bet: {x10}\nBC Bet: {bc}")
        elif block in {"X10 BET BUTTON", "BC BET BUTTON"}:
            ok = bool(payload.get("ok") or payload.get("found"))
            site = "X10" if block.startswith("X10") else "BC"
            self.lbl_test_result.setText(
                f"{site} Bet: {'OK' if ok else 'FAIL'}\n"
                f"text={payload.get('button_text') or '-'}\n"
                f"reason={payload.get('reason') or '-'}"
            )
        elif block in {"BC STAKE SYNC OK", "BC STAKE SYNC FAILED"} and payload.get("test"):
            self.set_test_result(
                ok=bool(payload.get("success")),
                actual=payload.get("actual"),
                reason=str(payload.get("reason") or ""),
            )

        if block.startswith("BC") or payload.get("step"):
            line = f"[{block}]"
            if payload.get("step"):
                line += f" step={payload.get('step')}"
            line += f" found={found} selector={selector or '-'} value={current_value}"
            self.txt_log.append(line)

    def _set_found_status(self, found: bool) -> None:
        if found:
            self.lbl_found.setText("FOUND")
            self.lbl_found.setProperty("class", "status-ok")
        else:
            self.lbl_found.setText("NOT FOUND")
            self.lbl_found.setProperty("class", "status-bad")
        self.lbl_found.style().unpolish(self.lbl_found)
        self.lbl_found.style().polish(self.lbl_found)

    def _fill_scan_table(self, scans: list[dict[str, Any]]) -> None:
        self.tbl_scan.setRowCount(len(scans))
        for row, scan in enumerate(scans):
            values = (
                str(scan.get("frame_url") or ""),
                str(scan.get("selector") or ""),
                str(scan.get("count") or ""),
                str(scan.get("placeholder") or ""),
                str(scan.get("type") or ""),
                str(scan.get("inputmode") or ""),
                str(scan.get("class") or ""),
                str(scan.get("value") or ""),
                str(scan.get("outerHTML") or ""),
            )
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.tbl_scan.setItem(row, col, item)

    def _fill_probe_table(self, candidates: list[dict[str, Any]]) -> None:
        self.tbl_probe.setRowCount(len(candidates))
        for row, cand in enumerate(candidates):
            probe = cand.get("probe") if isinstance(cand.get("probe"), dict) else {}
            values = (
                str(cand.get("frame_url") or ""),
                str(cand.get("selector") or ""),
                str(probe.get("focus_ok", "")),
                str(probe.get("value", cand.get("value", ""))),
                str(probe.get("placeholder", cand.get("placeholder", ""))),
                str(probe.get("disabled", cand.get("disabled", ""))),
                str(probe.get("readonly", cand.get("readonly", ""))),
                str(probe.get("aria-disabled", cand.get("aria-disabled", ""))),
            )
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.tbl_probe.setItem(row, col, item)
