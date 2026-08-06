from __future__ import annotations

from PyQt6.QtWidgets import QDialog, QHBoxLayout, QPushButton, QTableWidget, QTableWidgetItem, QVBoxLayout


class LogWindow(QDialog):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("실행 로그")
        self.resize(900, 400)
        layout = QVBoxLayout(self)
        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["시간", "사이트", "상태", "배당", "수익률", "메시지"])
        layout.addWidget(self.table)
        row = QHBoxLayout()
        btn_clear = QPushButton("지우기")
        btn_clear.clicked.connect(lambda: self.table.setRowCount(0))
        row.addStretch()
        row.addWidget(btn_clear)
        layout.addLayout(row)

    def append(self, timestamp: str, site: str, status: str, odds: str, profit: str, message: str) -> None:
        row = self.table.rowCount()
        self.table.insertRow(row)
        for col, val in enumerate([timestamp, site, status, odds, profit, message]):
            self.table.setItem(row, col, QTableWidgetItem(val))
        self.table.scrollToBottom()
