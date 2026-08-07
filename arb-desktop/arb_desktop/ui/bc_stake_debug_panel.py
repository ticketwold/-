from __future__ import annotations

from typing import Any

from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QDoubleSpinBox,
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

    test_requested = pyqtSignal(float)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._mono = QFont("Consolas", 9)

        test_box = QGroupBox("BC 금액 입력 테스트")
        test_row = QHBoxLayout(test_box)
        self.spin_test_amount = QDoubleSpinBox()
        self.spin_test_amount.setRange(0.1, 9999.0)
        self.spin_test_amount.setSingleStep(0.1)
        self.spin_test_amount.setDecimals(1)
        self.spin_test_amount.setValue(1.0)
        self.spin_test_amount.setSuffix(" USDT")
        self.btn_test = QPushButton("BC 금액 입력 테스트")
        self.btn_test.setProperty("class", "primary")
        self.lbl_test_result = QLabel("—")
        self.lbl_test_result.setWordWrap(True)
        test_row.addWidget(QLabel("테스트 금액"))
        test_row.addWidget(self.spin_test_amount)
        test_row.addWidget(self.btn_test)
        test_row.addWidget(self.lbl_test_result, 1)
        self.btn_test.clicked.connect(self._on_test)

        locator_box = QGroupBox("Stake Input Locator")
        locator_form = QFormLayout(locator_box)
        self.lbl_selector = QLabel("—")
        self.lbl_frame_url = QLabel("—")
        self.lbl_current_value = QLabel("—")
        self.lbl_status = QLabel("—")
        for lbl in (self.lbl_selector, self.lbl_frame_url, self.lbl_current_value, self.lbl_status):
            lbl.setFont(self._mono)
            lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            lbl.setWordWrap(True)
        locator_form.addRow("selector", self.lbl_selector)
        locator_form.addRow("frame_url", self.lbl_frame_url)
        locator_form.addRow("current_value", self.lbl_current_value)
        locator_form.addRow("상태", self.lbl_status)

        verify_box = QGroupBox("입력 검증")
        verify_form = QFormLayout(verify_box)
        self.lbl_requested = QLabel("—")
        self.lbl_before = QLabel("—")
        self.lbl_after = QLabel("—")
        self.lbl_v50 = QLabel("—")
        self.lbl_v100 = QLabel("—")
        self.lbl_v250 = QLabel("—")
        self.lbl_disabled = QLabel("—")
        self.lbl_react_reset = QLabel("—")
        for lbl in (
            self.lbl_requested,
            self.lbl_before,
            self.lbl_after,
            self.lbl_v50,
            self.lbl_v100,
            self.lbl_v250,
            self.lbl_disabled,
            self.lbl_react_reset,
        ):
            lbl.setFont(self._mono)
            lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        verify_form.addRow("requested stake", self.lbl_requested)
        verify_form.addRow("before value", self.lbl_before)
        verify_form.addRow("after value", self.lbl_after)
        verify_form.addRow("50ms value", self.lbl_v50)
        verify_form.addRow("100ms value", self.lbl_v100)
        verify_form.addRow("250ms value", self.lbl_v250)
        verify_form.addRow("disabled/readonly", self.lbl_disabled)
        verify_form.addRow("React reset", self.lbl_react_reset)

        scan_box = QGroupBox("BC STAKE INPUT SCAN")
        scan_layout = QVBoxLayout(scan_box)
        self.tbl_scan = QTableWidget(0, 8)
        self.tbl_scan.setHorizontalHeaderLabels(
            ["selector", "count", "placeholder", "type", "inputmode", "class", "data-editor-id", "value"]
        )
        self.tbl_scan.horizontalHeader().setStretchLastSection(True)
        self.tbl_scan.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.tbl_scan.setFont(self._mono)
        scan_layout.addWidget(self.tbl_scan)

        log_box = QGroupBox("최근 sync 로그")
        log_layout = QVBoxLayout(log_box)
        self.txt_log = QTextEdit()
        self.txt_log.setReadOnly(True)
        self.txt_log.setFont(self._mono)
        self.txt_log.setMaximumHeight(160)
        log_layout.addWidget(self.txt_log)

        root = QVBoxLayout(self)
        root.addWidget(test_box)
        root.addWidget(locator_box)
        root.addWidget(verify_box)
        root.addWidget(scan_box, 1)
        root.addWidget(log_box)

    def _on_test(self) -> None:
        self.lbl_test_result.setText("전송 중...")
        self.test_requested.emit(float(self.spin_test_amount.value()))

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

        if block in {"BC STAKE INPUT FOUND", "BC STAKE INPUT SCAN"} or payload.get("selected_selector"):
            self.lbl_selector.setText(str(debug.get("selected_selector") or debug.get("selector") or payload.get("selector") or "—"))
            self.lbl_frame_url.setText(str(debug.get("frame_url") or payload.get("frame_url") or "—"))
            self.lbl_current_value.setText(str(debug.get("current_value") or debug.get("after_value") or payload.get("actual") or "—"))

        if block.startswith("BC STAKE"):
            reason = str(payload.get("reason") or debug.get("reason") or "")
            success = payload.get("success")
            if success is True:
                self.lbl_status.setText("동기화 완료")
                self.lbl_status.setProperty("class", "status-ok")
            elif success is False:
                self.lbl_status.setText(_reason_label(reason))
                self.lbl_status.setProperty("class", "status-bad")
            self.lbl_status.style().unpolish(self.lbl_status)
            self.lbl_status.style().polish(self.lbl_status)

        self.lbl_requested.setText(str(debug.get("requested") or payload.get("requested") or "—"))
        self.lbl_before.setText(str(debug.get("before_value") or "—"))
        self.lbl_after.setText(str(debug.get("after_value") or payload.get("actual") or "—"))
        self.lbl_v50.setText(str(debug.get("verify_50ms") or "—"))
        self.lbl_v100.setText(str(debug.get("verify_100ms") or "—"))
        self.lbl_v250.setText(str(debug.get("verify_250ms") or "—"))
        disabled = debug.get("disabled") or debug.get("readonly") or debug.get("aria_disabled")
        self.lbl_disabled.setText(str(disabled if disabled is not None else "—"))
        self.lbl_react_reset.setText("yes" if debug.get("react_reset") else "no")

        scans = debug.get("scans") or payload.get("scans") or []
        if scans:
            self._fill_scan_table(scans)

        line = f"[{block}] requested={payload.get('requested')} actual={payload.get('actual')} reason={payload.get('reason')}"
        self.txt_log.append(line)

    def _fill_scan_table(self, scans: list[dict[str, Any]]) -> None:
        self.tbl_scan.setRowCount(len(scans))
        for row, scan in enumerate(scans):
            values = (
                str(scan.get("selector") or ""),
                str(scan.get("count") or ""),
                str(scan.get("placeholder") or ""),
                str(scan.get("type") or ""),
                str(scan.get("inputmode") or ""),
                str(scan.get("class") or ""),
                str(scan.get("data-editor-id") or ""),
                str(scan.get("value") or ""),
            )
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.tbl_scan.setItem(row, col, item)


def _reason_label(reason: str) -> str:
    mapping = {
        "stake-input-not-found": "입력창을 찾지 못함",
        "frame-not-found": "BetSlip 프레임을 찾지 못함",
        "value-not-applied": "입력값이 적용되지 않음",
        "react-reset-value": "사이트가 입력값을 다시 초기화함",
        "input-disabled": "입력창이 비활성화됨",
        "command-timeout": "명령 시간 초과",
    }
    return mapping.get(reason, reason or "동기화 실패")
