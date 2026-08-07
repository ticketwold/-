from __future__ import annotations

from typing import Any

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QFormLayout,
    QGroupBox,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
    QLabel,
)


class BcSlipDebugPanel(QWidget):
    """BC BetSlip scanner diagnostics."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._mono = QFont("Consolas", 9)

        meta_box = QGroupBox("BC Debug")
        meta_form = QFormLayout(meta_box)
        self.lbl_injected = QLabel("—")
        self.lbl_selected_frame = QLabel("—")
        self.lbl_root_found = QLabel("—")
        self.lbl_selector = QLabel("—")
        self.lbl_match_count = QLabel("—")
        self.lbl_slip_count = QLabel("—")
        self.lbl_odds = QLabel("—")
        self.lbl_status = QLabel("—")
        for lbl in (
            self.lbl_injected,
            self.lbl_selected_frame,
            self.lbl_root_found,
            self.lbl_selector,
            self.lbl_match_count,
            self.lbl_slip_count,
            self.lbl_odds,
            self.lbl_status,
        ):
            lbl.setFont(self._mono)
            lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            lbl.setWordWrap(True)
        meta_form.addRow("Injected frames", self.lbl_injected)
        meta_form.addRow("Selected frame", self.lbl_selected_frame)
        meta_form.addRow("Root found", self.lbl_root_found)
        meta_form.addRow("Selector", self.lbl_selector)
        meta_form.addRow("Match count", self.lbl_match_count)
        meta_form.addRow("Slip count", self.lbl_slip_count)
        meta_form.addRow("Odds", self.lbl_odds)
        meta_form.addRow("Status", self.lbl_status)

        selector_box = QGroupBox("BC selector scan")
        selector_layout = QVBoxLayout(selector_box)
        self.tbl_selectors = QTableWidget(0, 3)
        self.tbl_selectors.setHorizontalHeaderLabels(["selector", "match_count", "sample_text"])
        self.tbl_selectors.horizontalHeader().setStretchLastSection(True)
        self.tbl_selectors.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.tbl_selectors.setFont(self._mono)
        selector_layout.addWidget(self.tbl_selectors)

        text_box = QGroupBox("InnerText")
        text_layout = QVBoxLayout(text_box)
        self.txt_inner = QTextEdit()
        self.txt_inner.setReadOnly(True)
        self.txt_inner.setFont(self._mono)
        self.txt_inner.setMaximumHeight(140)
        text_layout.addWidget(self.txt_inner)

        root = QVBoxLayout(self)
        root.addWidget(meta_box)
        root.addWidget(selector_box, 1)
        root.addWidget(text_box)

    def update_from_payload(self, payload: dict[str, Any] | None) -> None:
        if not payload:
            return
        block = str(payload.get("block") or "").upper()
        if block not in {"BC DEBUG", "BC FRAME", "CONTENT SCRIPT LOADED", "SLIP ITEM", "SLIP ROOT FOUND"}:
            if not payload.get("slip_root_found") and not payload.get("selector_hits"):
                return

        injected = payload.get("injected_frames")
        if injected is not None:
            self.lbl_injected.setText(str(injected))

        frame_id = payload.get("frame_id")
        frame_url = str(payload.get("frame_url") or payload.get("best_frame_url") or "—")
        if frame_id is not None:
            self.lbl_selected_frame.setText(f"id={frame_id} | {frame_url}")
        elif payload.get("best_frame_id") is not None:
            self.lbl_selected_frame.setText(
                f"id={payload.get('best_frame_id')} | {payload.get('best_frame_url', frame_url)}"
            )

        found = payload.get("slip_root_found") or payload.get("found")
        if found is not None:
            self.lbl_root_found.setText(str(found))

        self.lbl_selector.setText(str(payload.get("selector") or payload.get("container_selector") or "—"))
        self.lbl_match_count.setText(str(payload.get("match_count") or "—"))
        if payload.get("slip_count") is not None:
            self.lbl_slip_count.setText(str(payload.get("slip_count")))
        odds = payload.get("extracted_odds")
        if odds is None and payload.get("odds") is not None:
            odds = payload.get("odds")
        self.lbl_odds.setText("—" if odds is None else str(odds))
        status = payload.get("parsed_status") or payload.get("status") or payload.get("last_status")
        self.lbl_status.setText(str(status or "—"))

        hits = payload.get("selector_hits") or payload.get("selector_scans") or []
        if hits:
            self._fill_selector_table(hits)

        inner = str(payload.get("slip_inner_text") or payload.get("text") or "")
        if inner:
            self.txt_inner.setPlainText(inner[:1000])

    def update_site_state(self, state: dict[str, Any] | None) -> None:
        if not state:
            return
        if state.get("injected_frames") is not None:
            self.lbl_injected.setText(str(state.get("injected_frames")))
        if state.get("best_frame_id") is not None:
            self.lbl_selected_frame.setText(
                f"id={state.get('best_frame_id')} | {state.get('best_frame_url', '—')}"
            )
        if state.get("last_odds") is not None:
            self.lbl_odds.setText(str(state.get("last_odds")))
        if state.get("last_status"):
            self.lbl_status.setText(str(state.get("last_status")))

    def _fill_selector_table(self, hits: list[dict[str, Any]]) -> None:
        self.tbl_selectors.setRowCount(len(hits))
        for row, hit in enumerate(hits):
            values = (
                str(hit.get("selector") or ""),
                str(hit.get("match_count") or ""),
                str(hit.get("sample_text") or ""),
            )
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.tbl_selectors.setItem(row, col, item)
