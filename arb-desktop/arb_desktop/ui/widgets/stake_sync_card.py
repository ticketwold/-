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
        effective_calc = calc if calc is not None else (m.bc_stake_usdt if m.bc_stake_usdt else None)
        self.lbl_calc.setText(
            f"{effective_calc:.1f} USDT" if effective_calc is not None else "—"
        )
        self.lbl_actual.setText(f"{actual:.1f} USDT" if actual is not None else "—")

        state = m.stake_sync_state or "IDLE"
        msg = m.stake_sync_message or state
        if state == "OK":
            display = "동기화 완료"
            css = "status-ok"
        elif state == "INPUT_NOT_FOUND":
            display = getattr(m, "stake_sync_reason", "") or msg or "input-not-found"
            css = "status-bad"
        elif state == "FAILED":
            display = getattr(m, "stake_sync_reason", "") or msg or _reason_label(state)
            css = "status-bad"
        elif state == "SYNCING":
            display = "동기화 중..."
            css = "status-warn"
        elif not enabled:
            display = "추천 금액만 표시"
            css = "muted"
        elif effective_calc is not None and actual is None and enabled:
            display = "Stake input not found"
            css = "status-bad"
        else:
            display = msg or "대기"
            css = "muted"

        self.lbl_state.setText(display)
        self.lbl_state.setProperty("class", css)
        self.lbl_state.style().unpolish(self.lbl_state)
        self.lbl_state.style().polish(self.lbl_state)


def _reason_label(reason: str) -> str:
    mapping = {
        "stake-input-not-found": "Stake input not found",
        "react-reset-value": "사이트가 입력값을 다시 초기화함",
        "value-not-applied": "입력값이 적용되지 않음",
        "input-disabled": "입력창이 비활성화됨",
        "frame-not-found": "BetSlip 프레임을 찾지 못함",
    }
    return mapping.get(reason, reason)
