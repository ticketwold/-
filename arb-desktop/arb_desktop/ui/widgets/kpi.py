from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout

from arb_desktop.ui.widgets.card import CardFrame
from arb_desktop.ui.watch_engine import WatchMetrics


class ProfitKpi(CardFrame):
    """Central profit KPI — largest element on dashboard."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent, elevated=True)
        layout = self.body

        self.lbl_title = QLabel("현재 최저 수익률")
        self.lbl_title.setProperty("class", "kpi-label")
        self.lbl_title.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.lbl_rate = QLabel("—")
        self.lbl_rate.setProperty("class", "kpi-value")
        self.lbl_rate.setAlignment(Qt.AlignmentFlag.AlignCenter)

        row = QHBoxLayout()
        row.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_target = QLabel("목표 —")
        self.lbl_target.setProperty("class", "muted")
        self.lbl_delta = QLabel("")
        self.lbl_delta.setProperty("class", "kpi-delta")
        row.addWidget(self.lbl_target)
        row.addWidget(self.lbl_delta)

        layout.addWidget(self.lbl_title)
        layout.addWidget(self.lbl_rate)
        layout.addLayout(row)

    def update_metrics(self, m: WatchMetrics) -> None:
        if not m.total_stake_krw:
            self.lbl_rate.setText("—")
            self.lbl_rate.setProperty("class", "kpi-value")
            self.lbl_target.setText("목표 —")
            self.lbl_delta.setText("")
            self._repolish(self.lbl_rate)
            return

        rate = m.current_profit_rate
        sign = "+" if rate >= 0 else ""
        self.lbl_rate.setText(f"{sign}{rate:.2f}%")
        css = "kpi-value positive" if rate >= m.target_profit_pct else "kpi-value negative"
        self.lbl_rate.setProperty("class", css)
        self._repolish(self.lbl_rate)

        self.lbl_target.setText(f"목표 {m.target_profit_pct:.2f}%")
        delta = m.target_delta_pct
        dsign = "+" if delta >= 0 else ""
        self.lbl_delta.setText(f"{dsign}{delta:.2f}%p")
        delta_css = "kpi-delta positive" if delta >= 0 else "kpi-delta negative"
        self.lbl_delta.setProperty("class", delta_css)
        self._repolish(self.lbl_delta)

    @staticmethod
    def _repolish(widget: QLabel) -> None:
        widget.style().unpolish(widget)
        widget.style().polish(widget)
