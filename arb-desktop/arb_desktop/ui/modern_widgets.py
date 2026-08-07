"""Modern desktop UI building blocks."""

from __future__ import annotations

from PyQt6.QtCore import QEasingCurve, QPropertyAnimation, Qt, QTimer
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import QFrame, QGraphicsOpacityEffect, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from arb_desktop.ui.icon_helper import icon


def _repolish(widget: QWidget) -> None:
    widget.style().unpolish(widget)
    widget.style().polish(widget)


class Card(QFrame):
    def __init__(self, parent: QWidget | None = None, *, object_name: str = "") -> None:
        super().__init__(parent)
        self.setProperty("class", "glass-card")
        if object_name:
            self.setObjectName(object_name)


class Badge(QLabel):
    def __init__(self, text: str = "", kind: str = "idle", parent: QWidget | None = None) -> None:
        super().__init__(text, parent)
        self.setProperty("class", f"badge badge-{kind}")
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)

    def set_kind(self, text: str, kind: str) -> None:
        self.setText(text)
        self.setProperty("class", f"badge badge-{kind}")
        _repolish(self)


class ModernButton(QPushButton):
    def __init__(self, text: str = "", *, variant: str = "default", parent: QWidget | None = None) -> None:
        super().__init__(text, parent)
        self.setProperty("class", f"btn btn-{variant}")
        self.setMinimumHeight(44)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def set_variant(self, variant: str) -> None:
        self.setProperty("class", f"btn btn-{variant}")
        _repolish(self)


class FlashOddsLabel(QLabel):
    """배당 숫자 — 변경 시 0.5초 플래시."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("class", "odds-value")
        self._last: str = ""
        self._flash_timer = QTimer(self)
        self._flash_timer.setSingleShot(True)
        self._flash_timer.timeout.connect(self._end_flash)

    def set_odds(self, odds: float | None, direction: int = 0) -> None:
        text = f"{odds:.2f}" if odds else "—"
        arrow = " ↑" if direction > 0 else " ↓" if direction < 0 else ""
        full = f"{text}{arrow}"
        if text != self._last and self._last:
            self._start_flash(direction)
        self._last = text
        self.setText(full)
        css = "odds-value odds-up" if direction > 0 else "odds-value odds-down" if direction < 0 else "odds-value"
        self.setProperty("class", css)
        _repolish(self)

    def _start_flash(self, direction: int) -> None:
        flash = "flash-up" if direction > 0 else "flash-down" if direction < 0 else "flash-neutral"
        self.setProperty("class", f"odds-value {flash}")
        _repolish(self)
        self._flash_timer.start(500)

    def _end_flash(self) -> None:
        cls = self.property("class") or "odds-value"
        base = str(cls).split()[0] if cls else "odds-value"
        self.setProperty("class", base)
        _repolish(self)


class MiniStatCard(Card):
    """상단 Bridge/BC/x10/FX/Watch 미니 카드."""

    def __init__(self, title: str, *, icon_name: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(6)
        title_row = QHBoxLayout()
        title_row.setSpacing(6)
        if icon_name:
            icon_lbl = QLabel()
            icon_lbl.setPixmap(icon(icon_name, "#A8B0BE").pixmap(16, 16))
            title_row.addWidget(icon_lbl)
        self.lbl_title = QLabel(title)
        self.lbl_title.setProperty("class", "card-subtitle")
        title_row.addWidget(self.lbl_title)
        title_row.addStretch()
        layout.addLayout(title_row)
        self.lbl_value = QLabel("—")
        self.lbl_value.setProperty("class", "card-value")
        self.badge = Badge("—", "idle")
        layout.addWidget(self.lbl_value)
        layout.addWidget(self.badge, alignment=Qt.AlignmentFlag.AlignLeft)

    def update_card(self, value: str, badge_text: str, badge_kind: str) -> None:
        self.lbl_value.setText(value)
        self.badge.set_kind(badge_text, badge_kind)


class SiteCard(Card):
    """텐텐벳 / BC.Game 대형 사이트 카드."""

    def __init__(self, site_name: str, *, accent: str = "x10", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setProperty("accent", accent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 18)
        layout.setSpacing(10)

        self.lbl_site = QLabel(site_name)
        self.lbl_site.setProperty("class", "site-title")
        self.lbl_selection = QLabel("—")
        self.lbl_selection.setProperty("class", "selection-big")
        self.lbl_selection.setWordWrap(True)
        self.lbl_odds_label = QLabel("배당")
        self.lbl_odds_label.setProperty("class", "card-subtitle")
        self.lbl_odds = FlashOddsLabel()
        self.badge = Badge("—", "idle")
        self.lbl_stake = QLabel("")
        self.lbl_stake.setProperty("class", "card-subtitle")
        self.lbl_changed = QLabel("")
        self.lbl_changed.setProperty("class", "card-subtitle")

        layout.addWidget(self.lbl_site)
        layout.addWidget(self.lbl_selection)
        layout.addWidget(self.lbl_odds_label)
        layout.addWidget(self.lbl_odds)
        layout.addWidget(self.badge, alignment=Qt.AlignmentFlag.AlignLeft)
        layout.addWidget(self.lbl_stake)
        layout.addWidget(self.lbl_changed)
        layout.addStretch()

    def update_from(
        self,
        *,
        selection: str,
        odds: float | None,
        status_label: str,
        odds_dir: int = 0,
        odds_changed_at: str = "",
        stake_text: str = "",
    ) -> None:
        self.lbl_selection.setText(selection or "—")
        self.lbl_odds.set_odds(odds, odds_dir)
        self.lbl_stake.setText(stake_text)
        self.lbl_stake.setVisible(bool(stake_text))
        self.lbl_changed.setText(f"변경 {odds_changed_at}" if odds_changed_at else "")
        kind = _status_kind(status_label)
        badge = status_label if status_label else "—"
        self.badge.set_kind(badge.upper() if badge != "—" else "—", kind)


def _status_kind(label: str) -> str:
    u = (label or "").upper()
    if u == "ACTIVE":
        return "success"
    if "READY" in u:
        return "primary"
    if "WAIT" in u or "정지" in label or "대기" in label:
        return "warning"
    if "CLOSED" in u or "닫" in label or "ERROR" in u:
        return "danger"
    if "EMPTY" in u or "없음" in label or label == "—":
        return "idle"
    return "idle"


def fade_in(widget: QWidget, *, duration: int = 350) -> None:
    effect = QGraphicsOpacityEffect(widget)
    widget.setGraphicsEffect(effect)
    anim = QPropertyAnimation(effect, b"opacity", widget)
    anim.setDuration(duration)
    anim.setStartValue(0.0)
    anim.setEndValue(1.0)
    anim.setEasingCurve(QEasingCurve.Type.OutCubic)
    anim.start()
    widget._fade_anim = anim  # prevent GC
