from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QGridLayout, QGroupBox, QLabel, QVBoxLayout, QWidget

from arb_desktop.ui.watch_engine import WatchMetrics


class SiteBetCard(QGroupBox):
    def __init__(self, title: str, parent: QWidget | None = None) -> None:
        super().__init__(title, parent)
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        self.lbl_selection = QLabel("—")
        self.lbl_selection.setProperty("class", "selection-big")
        self.lbl_selection.setWordWrap(True)

        self.lbl_odds = QLabel("—")
        self.lbl_odds.setProperty("class", "odds-big")
        self.lbl_odds_arrow = QLabel("")
        self.lbl_odds_arrow.setProperty("class", "odds-flat")
        self.lbl_odds_changed = QLabel("")
        self.lbl_odds_changed.setProperty("class", "muted")
        self.lbl_status = QLabel("—")
        self.lbl_status.setProperty("class", "muted")

        for w in (self.lbl_selection, self.lbl_odds, self.lbl_odds_arrow, self.lbl_odds_changed, self.lbl_status):
            if isinstance(w, QLabel):
                w.setAlignment(Qt.AlignmentFlag.AlignLeft)
            layout.addWidget(w)

    def update_from(
        self,
        *,
        selection: str,
        odds: float | None,
        status_label: str,
        odds_dir: int = 0,
        odds_changed_at: str = "",
    ) -> None:
        self.lbl_selection.setText(selection or "—")
        self.lbl_odds.setText(f"{odds:.3f}" if odds else "—")
        arrow = "↑" if odds_dir > 0 else "↓" if odds_dir < 0 else ""
        self.lbl_odds_arrow.setText(arrow)
        arrow_css = "odds-up" if odds_dir > 0 else "odds-down" if odds_dir < 0 else "odds-flat"
        self.lbl_odds_arrow.setProperty("class", arrow_css)
        self.lbl_odds_arrow.style().unpolish(self.lbl_odds_arrow)
        self.lbl_odds_arrow.style().polish(self.lbl_odds_arrow)
        self.lbl_odds_changed.setText(f"변경 {odds_changed_at}" if odds_changed_at else "")

        self.lbl_status.setText(status_label or "—")
        status_css = (
            "status-ok"
            if status_label == "ACTIVE"
            else "status-warn"
            if status_label and ("정지" in status_label or "닫" in status_label)
            else "status-idle"
        )
        self.lbl_status.setProperty("class", status_css)
        self.lbl_status.style().unpolish(self.lbl_status)
        self.lbl_status.style().polish(self.lbl_status)


class BettingInfoPanel(QGroupBox):
    """양쪽 선택만 표시 (배팅 타입/검증 없음)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__("양쪽 선택", parent)
        grid = QGridLayout(self)
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(8)
        self.card_x10 = SiteBetCard("텐텐벳")
        self.card_bc = SiteBetCard("BC.Game")
        grid.addWidget(self.card_x10, 0, 0)
        grid.addWidget(self.card_bc, 0, 1)

    def update_metrics(self, m: WatchMetrics) -> None:
        self.card_x10.update_from(
            selection=m.x10_display_selection,
            odds=m.bti_odds,
            status_label=m.x10_site_label,
            odds_dir=m.bti_odds_dir,
            odds_changed_at=m.bti_odds_changed_at,
        )
        self.card_bc.update_from(
            selection=m.bc_display_selection,
            odds=m.bc_odds,
            status_label=m.bc_site_label,
            odds_dir=m.bc_odds_dir,
            odds_changed_at=m.bc_odds_changed_at,
        )
