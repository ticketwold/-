from __future__ import annotations

from PyQt6.QtWidgets import QGridLayout, QLabel

from arb_desktop.ui.widgets.card import CardFrame
from arb_desktop.ui.widgets.status_badge import StatusBadge
from arb_desktop.ui.watch_engine import WatchMetrics


class StakeSyncCard(CardFrame):
    """BC stake auto-sync status."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        layout = self.body

        header = QLabel("BC 금액 자동동기화")
        header.setProperty("class", "section-title")
        self.badge = StatusBadge("● OFF")
        self.badge.set_variant("off")

        grid = QGridLayout()
        grid.setHorizontalSpacing(16)
        grid.setVerticalSpacing(6)

        self.lbl_calc = QLabel("계산: —")
        self.lbl_actual = QLabel("실제 카트: —")
        self.lbl_state = QLabel("상태: —")
        for lbl in (self.lbl_calc, self.lbl_actual, self.lbl_state):
            lbl.setProperty("class", "mono")

        grid.addWidget(QLabel("계산"), 0, 0)
        grid.addWidget(self.lbl_calc, 0, 1)
        grid.addWidget(QLabel("실제 카트"), 1, 0)
        grid.addWidget(self.lbl_actual, 1, 1)
        grid.addWidget(QLabel("상태"), 2, 0)
        grid.addWidget(self.lbl_state, 2, 1)

        layout.addWidget(header)
        layout.addWidget(self.badge)
        layout.addLayout(grid)

    def update_sync(self, m: WatchMetrics) -> None:
        enabled = m.stake_sync_enabled
        self.badge.setText("● ON" if enabled else "● OFF")
        self.badge.set_variant("on" if enabled else "off")

        calc = m.stake_sync_calculated_usdt
        actual = m.stake_sync_actual_usdt
        self.lbl_calc.setText(f"{calc:.1f} USDT" if calc is not None else (f"{m.bc_stake_usdt:.1f} USDT" if m.bc_stake_usdt else "—"))
        self.lbl_actual.setText(f"{actual:.1f} USDT" if actual is not None else "—")

        state = m.stake_sync_state or "IDLE"
        msg = m.stake_sync_message or state
        if state == "OK":
            display = "동기화 완료"
            css = "status-ok"
        elif state in {"FAILED", "INPUT_NOT_FOUND"}:
            display = msg
            css = "status-bad"
        elif state == "SYNCING":
            display = "동기화 중..."
            css = "status-warn"
        elif not enabled:
            display = "추천 금액만 표시"
            css = "muted"
        else:
            display = msg or "대기"
            css = "muted"

        self.lbl_state.setText(display)
        self.lbl_state.setProperty("class", css)
        self.lbl_state.style().unpolish(self.lbl_state)
        self.lbl_state.style().polish(self.lbl_state)
