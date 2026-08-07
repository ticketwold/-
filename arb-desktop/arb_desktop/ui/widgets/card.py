from __future__ import annotations

from PyQt6.QtWidgets import QFrame, QVBoxLayout, QWidget


class CardFrame(QFrame):
    """Elevated surface card."""

    def __init__(self, parent: QWidget | None = None, *, elevated: bool = False) -> None:
        super().__init__(parent)
        self.setProperty("class", "Card")
        if elevated:
            self.setProperty("elevated", "true")
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(16, 14, 16, 14)
        self._layout.setSpacing(10)

    @property
    def body(self) -> QVBoxLayout:
        return self._layout
