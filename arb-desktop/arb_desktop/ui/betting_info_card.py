from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QGridLayout, QGroupBox, QLabel, QVBoxLayout, QWidget

from arb_desktop.ui.watch_engine import WatchMetrics


def _bet_type_css(label: str) -> str:
    t = (label or "").lower()
    if "언더" in t or "오버" in t or "total" in t:
        return "type-total"
    if "핸디" in t or "handicap" in t or "spread" in t:
        return "type-handicap"
    if "세트" in t or "set" in t:
        return "type-set"
    if "맵" in t or "map" in t:
        return "type-map"
    if "승" in t or "money" in t or "머니" in t:
        return "type-moneyline"
    return "type-default"


class SiteBetCard(QGroupBox):
    def __init__(self, title: str, parent: QWidget | None = None) -> None:
        super().__init__(title, parent)
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        self.lbl_selection = QLabel("—")
        self.lbl_selection.setProperty("class", "selection-big")
        self.lbl_selection.setWordWrap(True)

        odds_row = QWidget()
        odds_layout = QVBoxLayout(odds_row)
        odds_layout.setContentsMargins(0, 0, 0, 0)
        self.lbl_odds = QLabel("배당 —")
        self.lbl_odds.setProperty("class", "odds-big")
        self.lbl_odds_arrow = QLabel("")
        self.lbl_odds_arrow.setProperty("class", "odds-flat")
        self.lbl_odds_changed = QLabel("")
        self.lbl_odds_changed.setProperty("class", "muted")
        odds_layout.addWidget(self.lbl_odds)
        odds_layout.addWidget(self.lbl_odds_arrow)
        odds_layout.addWidget(self.lbl_odds_changed)

        self.lbl_type = QLabel("타입 —")
        self.lbl_type.setProperty("class", "type-default")
        self.lbl_status = QLabel("상태 —")
        self.lbl_status.setProperty("class", "muted")

        for w in (self.lbl_selection, odds_row, self.lbl_type, self.lbl_status):
            w.setAlignment(Qt.AlignmentFlag.AlignLeft) if isinstance(w, QLabel) else None
            layout.addWidget(w)

    def update_from(
        self,
        *,
        selection: str,
        odds: float | None,
        type_label: str,
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

        self.lbl_type.setText(type_label or "—")
        type_css = _bet_type_css(type_label)
        self.lbl_type.setProperty("class", type_css)
        self.lbl_type.style().unpolish(self.lbl_type)
        self.lbl_type.style().polish(self.lbl_type)

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
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__("양쪽 선택", parent)
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
        self.lbl_combined_type.setProperty("class", "type-default")
        self.lbl_raw_market = QLabel("원본 마켓: —")
        self.lbl_raw_market.setProperty("class", "muted")
        self.lbl_period = QLabel("경기 구간: —")
        self.lbl_period.setProperty("class", "muted")
        self.lbl_line = QLabel("기준점: 없음")
        self.lbl_line.setProperty("class", "metric")
        self.lbl_verify = QLabel("검증: —")
        for lbl in (self.lbl_combined_type, self.lbl_raw_market, self.lbl_period, self.lbl_line, self.lbl_verify):
            lbl.setWordWrap(True)
            s_layout.addWidget(lbl)
        grid.addWidget(summary, 1, 0, 1, 2)

    def update_metrics(self, m: WatchMetrics) -> None:
        self.card_x10.update_from(
            selection=m.x10_display_selection,
            odds=m.bti_odds,
            type_label=m.x10_bet_type_label,
            status_label=m.x10_site_label,
            odds_dir=m.bti_odds_dir,
            odds_changed_at=m.bti_odds_changed_at,
        )
        self.card_bc.update_from(
            selection=m.bc_display_selection,
            odds=m.bc_odds,
            type_label=m.bc_bet_type_label,
            status_label=m.bc_site_label,
            odds_dir=m.bc_odds_dir,
            odds_changed_at=m.bc_odds_changed_at,
        )
        self.lbl_combined_type.setText(f"배팅 타입: {m.combined_bet_type_label}")
        type_css = _bet_type_css(m.combined_bet_type_label)
        self.lbl_combined_type.setProperty("class", type_css)
        self.lbl_combined_type.style().unpolish(self.lbl_combined_type)
        self.lbl_combined_type.style().polish(self.lbl_combined_type)
        self.lbl_raw_market.setText(f"원본 마켓: {m.x10_raw_market}")
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
