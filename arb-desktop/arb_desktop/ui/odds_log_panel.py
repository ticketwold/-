from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor
from PyQt6.QtWidgets import (
    QCheckBox,
    QFileDialog,
    QHBoxLayout,
    QHeaderView,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from arb_desktop.ui.odds_log_manager import OddsLogEntry, OddsLogManager


class OddsLogPanel(QWidget):
    HEADERS = ["시간", "사이트", "이전", "현재", "상태", "수익률", "메시지"]

    def __init__(self, manager: OddsLogManager, logs_dir: Path, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._manager = manager
        self._logs_dir = logs_dir
        self._auto_scroll = True

        layout = QVBoxLayout(self)
        toolbar = QHBoxLayout()
        self.chk_auto_scroll = QCheckBox("자동 스크롤")
        self.chk_auto_scroll.setChecked(True)
        self.chk_auto_scroll.toggled.connect(self._on_auto_scroll)
        self.btn_open_log = QPushButton("배당 로그 열기")
        self.btn_open_folder = QPushButton("로그 폴더 열기")
        self.btn_clear = QPushButton("로그 지우기")
        self.btn_export = QPushButton("CSV보내기")
        for btn in (self.btn_open_log, self.btn_open_folder, self.btn_clear, self.btn_export):
            toolbar.addWidget(btn)
        toolbar.addStretch()
        toolbar.addWidget(self.chk_auto_scroll)
        layout.addLayout(toolbar)

        self.table = QTableWidget(0, len(self.HEADERS))
        self.table.setHorizontalHeaderLabels(self.HEADERS)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setAlternatingRowColors(True)
        layout.addWidget(self.table)

        self.btn_open_log.clicked.connect(self._open_log)
        self.btn_open_folder.clicked.connect(self._open_folder)
        self.btn_clear.clicked.connect(self._clear_memory)
        self.btn_export.clicked.connect(self._export_csv)

    def _on_auto_scroll(self, checked: bool) -> None:
        self._auto_scroll = checked

    def append_entry(self, entry: OddsLogEntry) -> None:
        row = self.table.rowCount()
        self.table.insertRow(row)
        for col, value in enumerate(entry.display_columns()):
            item = QTableWidgetItem(value)
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self._color_item(item, entry.site, entry.status)
            self.table.setItem(row, col, item)
        if self.table.rowCount() > 5000:
            self.table.removeRow(0)
        if self._auto_scroll:
            self.table.scrollToBottom()

    def _color_item(self, item: QTableWidgetItem, site: str, status: str) -> None:
        site_u = site.upper()
        status_u = status.upper()
        if status_u in {"READY"} or "WATCH ON" in status_u:
            item.setForeground(QColor("#23C26B"))
        elif status_u in {"CLOSED", "ERROR", "FAILED", "PARTIAL BET"} or "닫" in status:
            item.setForeground(QColor("#FF5C5C"))
        elif site_u in {"X10", "BTI"}:
            item.setForeground(QColor("#4A90FF"))
        elif site_u == "BC":
            item.setForeground(QColor("#F5A623"))
        elif site_u == "ENGINE":
            item.setForeground(QColor("#23C26B"))
        elif site_u == "APP":
            item.setForeground(QColor("#A8B0BE"))

    def _open_log(self) -> None:
        path = self._manager.open_today_csv()
        self._open_path(path)

    def _open_folder(self) -> None:
        self._open_path(self._logs_dir)

    def _open_path(self, path: Path) -> None:
        if sys.platform == "win32":
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path)], check=False)

    def _clear_memory(self) -> None:
        self._manager.clear_memory()
        self.table.setRowCount(0)

    def _export_csv(self) -> None:
        dest, _ = QFileDialog.getSaveFileName(
            self,
            "CSV보내기",
            str(self._logs_dir / "odds-export.csv"),
            "CSV Files (*.csv)",
        )
        if dest:
            self._manager.export_csv(Path(dest))
