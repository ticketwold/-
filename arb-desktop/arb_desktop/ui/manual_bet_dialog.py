from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from arb_desktop.ui.watch_engine import WatchMetrics


class ManualBetDialog(QDialog):
    """In-app manual bet confirmation — no system MessageBox."""

    def __init__(
        self,
        metrics: WatchMetrics,
        *,
        live: bool,
        below_target: bool,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("양쪽 배팅 실행")
        self.setMinimumWidth(440)
        self._below_target = below_target
        self._proceed_anyway = False

        layout = QVBoxLayout(self)
        layout.setSpacing(14)

        title = QLabel("양쪽 배팅 실행")
        title.setProperty("class", "dialog-title")
        layout.addWidget(title)

        x10_line = QLabel(self._x10_line(metrics))
        x10_line.setProperty("class", "mono")
        bc_line = QLabel(self._bc_line(metrics))
        bc_line.setProperty("class", "mono")
        layout.addWidget(x10_line)
        layout.addWidget(bc_line)

        rate = metrics.current_profit_rate
        sign = "+" if rate >= 0 else ""
        profit = QLabel(f"현재 최저 수익률 {sign}{rate:.2f}%")
        profit.setProperty("class", "kpi-value" if not below_target else "kpi-value negative")
        layout.addWidget(profit)

        if below_target:
            warn = QLabel(
                f"목표 {metrics.target_profit_pct:.2f}% 미달입니다.\n"
                f"현재 {sign}{rate:.2f}% — 그래도 실행하시겠습니까?"
            )
            warn.setProperty("class", "status-bad")
            warn.setWordWrap(True)
            layout.addWidget(warn)

        if not live:
            dry = QLabel("Dry Run — 실제 Bet 버튼은 클릭되지 않습니다.")
            dry.setProperty("class", "muted")
            layout.addWidget(dry)

        buttons = QDialogButtonBox()
        btn_cancel = buttons.addButton("취소", QDialogButtonBox.ButtonRole.RejectRole)
        buttons.rejected.connect(self.reject)
        if below_target:
            btn_force = QPushButton("그래도 실행")
            btn_force.setProperty("class", "danger")
            buttons.addButton(btn_force, QDialogButtonBox.ButtonRole.AcceptRole)
            btn_force.clicked.connect(self._force_accept)
        else:
            btn_go = buttons.addButton(
                "양쪽 병렬 배팅 실행" if live else "Dry Run 실행",
                QDialogButtonBox.ButtonRole.AcceptRole,
            )
            btn_go.setProperty("class", "primary")
            buttons.accepted.connect(self.accept)
        layout.addWidget(buttons)

    def _force_accept(self) -> None:
        self._proceed_anyway = True
        self.accept()

    @property
    def proceed_anyway(self) -> bool:
        return self._proceed_anyway

    @staticmethod
    def _x10_line(m: WatchMetrics) -> str:
        odds = m.bti_odds or m.bti_display_odds or 0
        return f"X10  {m.bti_stake_krw:,.0f} KRW @ {odds:.2f}"

    @staticmethod
    def _bc_line(m: WatchMetrics) -> str:
        usdt = m.stake_sync_actual_usdt or m.bc_stake_usdt or m.stake_sync_calculated_usdt or 0
        odds = m.bc_odds or 0
        return f"BC   {usdt:.1f} USDT @ {odds:.2f}"
