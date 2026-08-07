from __future__ import annotations

from typing import Any

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QFormLayout,
    QGroupBox,
    QLabel,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)


class X10DebugPanel(QWidget):
    """x10 BetSlip DOM/parser 실시간 디버그 패널."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._mono = QFont("Consolas", 9)

        meta_box = QGroupBox("프레임 정보")
        meta_form = QFormLayout(meta_box)
        self.lbl_frame_url = QLabel("—")
        self.lbl_document_location = QLabel("—")
        self.lbl_frame_depth = QLabel("—")
        self.lbl_document_ready = QLabel("—")
        self.lbl_body_text_length = QLabel("—")
        self.lbl_reason = QLabel("—")
        self.lbl_slip_root = QLabel("—")
        self.lbl_extracted_odds = QLabel("—")
        for lbl in (
            self.lbl_frame_url,
            self.lbl_document_location,
            self.lbl_frame_depth,
            self.lbl_document_ready,
            self.lbl_body_text_length,
            self.lbl_reason,
            self.lbl_slip_root,
            self.lbl_extracted_odds,
        ):
            lbl.setFont(self._mono)
            lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            lbl.setWordWrap(True)
        meta_form.addRow("Frame URL", self.lbl_frame_url)
        meta_form.addRow("document.location.href", self.lbl_document_location)
        meta_form.addRow("iframe depth", self.lbl_frame_depth)
        meta_form.addRow("document.readyState", self.lbl_document_ready)
        meta_form.addRow("body text length", self.lbl_body_text_length)
        meta_form.addRow("slip reason", self.lbl_reason)
        meta_form.addRow("SLIP ROOT FOUND", self.lbl_slip_root)
        meta_form.addRow("extracted odds", self.lbl_extracted_odds)

        odds_box = QGroupBox("배당 후보 / 제외 이유")
        odds_layout = QVBoxLayout(odds_box)
        self.tbl_odds = QTableWidget(0, 4)
        self.tbl_odds.setHorizontalHeaderLabels(["text", "value", "excluded", "exclude_reason"])
        self.tbl_odds.horizontalHeader().setStretchLastSection(True)
        self.tbl_odds.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.tbl_odds.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.tbl_odds.setFont(self._mono)
        odds_layout.addWidget(self.tbl_odds)

        selector_box = QGroupBox("selector별 match_count")
        selector_layout = QVBoxLayout(selector_box)
        self.tbl_selectors = QTableWidget(0, 3)
        self.tbl_selectors.setHorizontalHeaderLabels(["selector", "match_count", "sample_text"])
        self.tbl_selectors.horizontalHeader().setStretchLastSection(True)
        self.tbl_selectors.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.tbl_selectors.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.tbl_selectors.setFont(self._mono)
        selector_layout.addWidget(self.tbl_selectors)

        text_box = QGroupBox("x10 BetSlip innerText (최대 1000자)")
        text_layout = QVBoxLayout(text_box)
        self.txt_slip_inner = QTextEdit()
        self.txt_slip_inner.setReadOnly(True)
        self.txt_slip_inner.setFont(self._mono)
        self.txt_slip_inner.setPlaceholderText("slip root innerText 가 여기 표시됩니다")
        text_layout.addWidget(self.txt_slip_inner)

        parse_box = QGroupBox("베팅 파싱 (x10)")
        parse_form = QFormLayout(parse_box)
        self.lbl_raw_market_text = QLabel("—")
        self.lbl_raw_selection_text = QLabel("—")
        self.lbl_normalized_bet_type = QLabel("—")
        self.lbl_parsed_side = QLabel("—")
        self.lbl_parsed_line = QLabel("—")
        self.lbl_parsed_odds = QLabel("—")
        self.lbl_parse_reason = QLabel("—")
        for lbl in (
            self.lbl_raw_market_text,
            self.lbl_raw_selection_text,
            self.lbl_normalized_bet_type,
            self.lbl_parsed_side,
            self.lbl_parsed_line,
            self.lbl_parsed_odds,
            self.lbl_parse_reason,
        ):
            lbl.setFont(self._mono)
            lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            lbl.setWordWrap(True)
        parse_form.addRow("raw_market_text", self.lbl_raw_market_text)
        parse_form.addRow("raw_selection_text", self.lbl_raw_selection_text)
        parse_form.addRow("normalized_bet_type", self.lbl_normalized_bet_type)
        parse_form.addRow("parsed_side", self.lbl_parsed_side)
        parse_form.addRow("parsed_line", self.lbl_parsed_line)
        parse_form.addRow("parsed_odds", self.lbl_parsed_odds)
        parse_form.addRow("파싱 실패 사유", self.lbl_parse_reason)

        root = QVBoxLayout(self)
        root.addWidget(meta_box)
        root.addWidget(parse_box)
        root.addWidget(odds_box)
        root.addWidget(selector_box, 1)
        root.addWidget(text_box, 1)

    def update_from_payload(self, payload: dict[str, Any] | None) -> None:
        if not payload:
            return
        self.lbl_frame_url.setText(str(payload.get("frame_url") or "—"))
        self.lbl_document_location.setText(str(payload.get("document_location") or payload.get("frame_url") or "—"))
        self.lbl_frame_depth.setText(str(payload.get("frame_depth", "—")))
        self.lbl_document_ready.setText(str(payload.get("document_ready") or "—"))
        self.lbl_body_text_length.setText(str(payload.get("body_text_length", "—")))
        self.lbl_reason.setText(str(payload.get("reason") or "—"))

        found = payload.get("slip_root_found") or payload.get("found") or "—"
        self.lbl_slip_root.setText(str(found))
        if str(found).upper() == "YES":
            self.lbl_slip_root.setStyleSheet("color: #1b8f3a; font-weight: bold;")
        elif str(found).upper() == "NO":
            self.lbl_slip_root.setStyleSheet("color: #c0392b; font-weight: bold;")
        else:
            self.lbl_slip_root.setStyleSheet("")

        extracted = payload.get("extracted_odds")
        self.lbl_extracted_odds.setText("—" if extracted is None else str(extracted))

        hits = payload.get("selector_hits") or payload.get("selector_scans") or []
        self._fill_selector_table(hits)
        self._fill_odds_table(payload.get("odds_candidates") or [])

        inner = str(payload.get("slip_inner_text") or payload.get("text") or "")
        self.txt_slip_inner.setPlainText(inner[:1000])
        self._update_parse_fields(payload)

    def update_parse_debug(self, fields: dict[str, Any] | None) -> None:
        if fields:
            self._update_parse_fields(fields)

    def update_from_slip_item(self, item: dict[str, Any] | None) -> None:
        if not item:
            return
        self._update_parse_fields(item)

    def _update_parse_fields(self, payload: dict[str, Any]) -> None:
        self.lbl_raw_market_text.setText(str(payload.get("raw_market_text") or payload.get("market") or "—"))
        self.lbl_raw_selection_text.setText(str(payload.get("raw_selection_text") or payload.get("selection") or "—"))
        self.lbl_normalized_bet_type.setText(
            str(payload.get("normalized_bet_type") or payload.get("bet_type") or "—")
        )
        self.lbl_parsed_side.setText(str(payload.get("parsed_side") or payload.get("side") or "—"))
        line = payload.get("parsed_line")
        if line is None:
            line = payload.get("line")
        self.lbl_parsed_line.setText("—" if line is None or line == "" else str(line))
        odds = payload.get("parsed_odds")
        if odds is None:
            odds = payload.get("odds")
        self.lbl_parsed_odds.setText("—" if odds is None or odds == "" else str(odds))
        reason = str(payload.get("parse_reason") or "—")
        self.lbl_parse_reason.setText(reason)
        if reason and reason not in {"—", ""}:
            self.lbl_parse_reason.setStyleSheet("color: #c0392b;")
        else:
            self.lbl_parse_reason.setStyleSheet("color: #1b8f3a;")

    def update_from_slip_raw(self, raw: dict[str, Any] | None) -> None:
        if not raw:
            return
        if any(k in raw for k in ("selector_hits", "slip_inner_text", "odds_candidates", "extracted_odds")):
            self.update_from_payload(raw)
        items = raw.get("items") or []
        if items:
            self.update_from_slip_item(items[0] if isinstance(items[0], dict) else None)

    def _fill_selector_table(self, hits: list[dict[str, Any]]) -> None:
        self.tbl_selectors.setRowCount(len(hits))
        for row, hit in enumerate(hits):
            selector = str(hit.get("selector") or "")
            count = str(hit.get("match_count", 0))
            sample = str(hit.get("sample_text") or "")
            for col, value in enumerate((selector, count, sample)):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.tbl_selectors.setItem(row, col, item)
        self.tbl_selectors.resizeColumnsToContents()

    def _fill_odds_table(self, candidates: list[dict[str, Any]]) -> None:
        self.tbl_odds.setRowCount(len(candidates))
        for row, cand in enumerate(candidates):
            selected = " *" if cand.get("selected") else ""
            values = (
                str(cand.get("text") or "") + selected,
                str(cand.get("value", "")),
                str(cand.get("excluded", "")),
                str(cand.get("exclude_reason") or ""),
            )
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                if cand.get("selected"):
                    item.setBackground(Qt.GlobalColor.darkGreen)
                self.tbl_odds.setItem(row, col, item)
        self.tbl_odds.resizeColumnsToContents()
