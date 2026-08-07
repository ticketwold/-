from __future__ import annotations

from PyQt6.QtCore import QTimer, Qt
from PyQt6.QtWidgets import QLabel, QVBoxLayout

from arb_desktop.ui.widgets.card import CardFrame


def _arrow(direction: int) -> str:
    if direction > 0:
        return "↑"
    if direction < 0:
        return "↓"
    return ""


class SiteOddsCard(CardFrame):
    """Per-site odds + stake + status card."""

    def __init__(self, site_name: str, parent=None) -> None:
        super().__init__(parent)
        layout = self.body

        self.lbl_site = QLabel(site_name)
        self.lbl_site.setProperty("class", "site-title")

        self.lbl_odds = QLabel("—")
        self.lbl_odds.setProperty("class", "odds-hero")
        self.lbl_arrow = QLabel("")
        self.lbl_arrow.setProperty("class", "odds-flat")

        self.lbl_stake = QLabel("")
        self.lbl_stake.setProperty("class", "stake-line")
        self.lbl_status = QLabel("—")
        self.lbl_status.setProperty("class", "muted")
        self.lbl_changed = QLabel("")
        self.lbl_changed.setProperty("class", "muted")

        layout.addWidget(self.lbl_site)
        layout.addWidget(self.lbl_odds)
        layout.addWidget(self.lbl_arrow)
        layout.addWidget(self.lbl_stake)
        layout.addWidget(self.lbl_status)
        layout.addWidget(self.lbl_changed)

        self._flash_timer = QTimer(self)
        self._flash_timer.setSingleShot(True)
        self._flash_timer.timeout.connect(self._clear_flash)
        self._last_dir = 0

    def _clear_flash(self) -> None:
        self.setProperty("flash", "")
        self.style().unpolish(self)
        self.style().polish(self)

    def update_card(
        self,
        *,
        odds: float | None,
        direction: int,
        stake_text: str,
        status: str,
        changed_at: str = "",
        display_odds: float | None = None,
        status_label: str = "",
    ) -> None:
        show = odds if odds is not None else display_odds
        label = f"{show:.3f}" if show else "—"
        if show and odds is None and status_label and status_label != "ACTIVE":
            label = f"{show:.2f} (마지막)"
        self.lbl_odds.setText(label)
        self.lbl_arrow.setText(_arrow(direction) if show else "")
        arrow_css = "odds-up" if direction > 0 else "odds-down" if direction < 0 else "odds-flat"
        self.lbl_arrow.setProperty("class", arrow_css)
        self.lbl_arrow.style().unpolish(self.lbl_arrow)
        self.lbl_arrow.style().polish(self.lbl_arrow)

        if direction != 0 and direction != self._last_dir:
            flash = "up" if direction > 0 else "down"
            self.setProperty("flash", flash)
            self.style().unpolish(self)
            self.style().polish(self)
            self._flash_timer.start(220)
        self._last_dir = direction

        self.lbl_stake.setText(stake_text or "")
        self.lbl_stake.setVisible(bool(stake_text))
        self.lbl_status.setText(status or "—")
        status_css = (
            "status-ok"
            if status == "ACTIVE"
            else "status-bad"
            if status and ("닫" in status or "CLOSED" in status.upper())
            else "status-warn"
        )
        self.lbl_status.setProperty("class", status_css)
        self.lbl_status.style().unpolish(self.lbl_status)
        self.lbl_status.style().polish(self.lbl_status)
        self.lbl_changed.setText(changed_at.replace("\n", " · ") if changed_at else "")
