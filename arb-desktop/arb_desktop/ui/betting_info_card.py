from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QGridLayout, QGroupBox, QLabel, QVBoxLayout, QWidget

from arb_desktop.ui.watch_engine import WatchMetrics


class SiteBetCard(QGroupBox):
    def __init__(self, title: str, parent: QWidget | None = None) -> None:
        super().__init__(title, parent)
        layout = QVBoxLayout(self)
        layout.setSpacing(6)
        self.lbl_selection = QLabel("—")
        self.lbl_selection.setProperty("class", "hero")
        self.lbl_selection.setWordWrap(True)
        self.lbl_odds = QLabel("배당 —")
        self.lbl_odds.setProperty("class", "metric")
        self.lbl_type = QLabel("타입 —")
        self.lbl_type.setProperty("class", "muted")
        self.lbl_status = QLabel("상태 —")
        self.lbl_status.setProperty("class", "muted")
        for w in (self.lbl_selection, self.lbl_odds, self.lbl_type, self.lbl_status):
            w.setAlignment(Qt.AlignmentFlag.AlignLeft)
            layout.addWidget(w)

    def update_from(self, *, selection: str, odds: float | None, type_label: str, status_label: str) -> None:
        self.lbl_selection.setText(selection or "—")
        self.lbl_odds.setText(f"배당 {odds:.3f}" if odds else "배당 —")
        self.lbl_type.setText(f"타입 {type_label}")
        self.lbl_status.setText(f"상태 {status_label}")
        css = "status-ok" if status_label == "ACTIVE" else "status-warn" if "정지" in status_label or "닫" in status_label else "status-idle"
        self.lbl_status.setProperty("class", css)
        self.lbl_status.style().unpolish(self.lbl_status)
        self.lbl_status.style().polish(self.lbl_status)


class BettingInfoPanel(QGroupBox):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__("배팅 정보", parent)
        grid = QGridLayout(self)
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(8)

        self.card_x10 = SiteBetCard("텐텐벳")
        self.card_bc = SiteBetCard("BC.Game")
        grid.addWidget(self.card_x10, 0, 0)
        grid.addWidget(self.card_bc, 0, 1)

        summary = QWidget()
        s_layout = QVBoxLayout(summary)
        s_layout.setContentsMargins(0, 8, 0, 0)
        self.lbl_combined_type = QLabel("배팅 타입: —")
        self.lbl_period = QLabel("경기 구간: —")
        self.lbl_line = QLabel("기준점: 없음")
        self.lbl_verify = QLabel("검증: —")
        for lbl in (self.lbl_combined_type, self.lbl_period, self.lbl_line, self.lbl_verify):
            lbl.setWordWrap(True)
            s_layout.addWidget(lbl)
        grid.addWidget(summary, 1, 0, 1, 2)

    def update_metrics(self, m: WatchMetrics) -> None:
        self.card_x10.update_from(
            selection=m.x10_display_selection,
            odds=m.bti_odds,
            type_label=m.x10_bet_type_label,
            status_label=m.x10_site_label,
        )
        self.card_bc.update_from(
            selection=m.bc_display_selection,
            odds=m.bc_odds,
            type_label=m.bc_bet_type_label,
            status_label=m.bc_site_label,
        )
        self.lbl_combined_type.setText(f"배팅 타입: {m.combined_bet_type_label}")
        self.lbl_period.setText(f"경기 구간: {m.period_label}")
        self.lbl_line.setText(f"기준점: {m.line_label}")
        self.lbl_verify.setText(f"검증: {m.verify_label}")
        if m.bet_mismatch_kind:
            self.lbl_verify.setProperty("class", "status-bad")
        elif m.verify_label == "정상" or "반대" in m.verify_label:
            self.lbl_verify.setProperty("class", "status-ok")
        else:
            self.lbl_verify.setProperty("class", "status-warn")
        self.lbl_verify.style().unpolish(self.lbl_verify)
        self.lbl_verify.style().polish(self.lbl_verify)
