"""Dark console log strip for main dashboard."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont, QTextCharFormat, QColor
from PyQt6.QtWidgets import QFrame, QLabel, QTextEdit, QVBoxLayout, QWidget

from arb_desktop.ui.icon_helper import icon
from arb_desktop.ui.log_manager import LogEntry


class ConsoleLogPanel(QFrame):
    MAX_LINES = 200

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "console-panel")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        header = QLabel("  로그")
        header.setProperty("class", "card-subtitle")
        header.setPixmap(icon("log", "#A8B0BE").pixmap(14, 14))
        layout.addWidget(header)

        self.text = QTextEdit()
        self.text.setReadOnly(True)
        self.text.setProperty("class", "console")
        mono = QFont("Consolas", 10)
        if not mono.exactMatch():
            mono = QFont("Courier New", 10)
        self.text.setFont(mono)
        self.text.setMinimumHeight(140)
        self.text.setMaximumHeight(200)
        layout.addWidget(self.text)

    def append(self, entry: LogEntry) -> None:
        color = self._color_for(entry)
        html = (
            f'<span style="color:#6B7280">{entry.timestamp}</span> '
            f'<span style="color:{color}">{entry.site}</span> '
            f'<span style="color:#A8B0BE">{entry.status}</span> '
            f'<span style="color:#FFFFFF">{entry.message}</span>'
        )
        self.text.append(html)
        doc = self.text.document()
        if doc.blockCount() > self.MAX_LINES:
            cursor = self.text.textCursor()
            cursor.movePosition(cursor.MoveOperation.Start)
            cursor.select(cursor.SelectionType.BlockUnderCursor)
            cursor.removeSelectedText()
            cursor.deleteChar()
        self.text.verticalScrollBar().setValue(self.text.verticalScrollBar().maximum())

    @staticmethod
    def _color_for(entry: LogEntry) -> str:
        site = entry.site.upper()
        status = entry.status.upper()
        if "READY" in status:
            return "#23C26B"
        if "ERROR" in status or "FAIL" in status or "CLOSED" in status:
            return "#FF5C5C"
        if site in {"X10", "BTI", "X10DBG"}:
            return "#4A90FF"
        if site == "BC":
            return "#F5A623"
        if site == "ENGINE":
            return "#23C26B"
        return "#A8B0BE"
