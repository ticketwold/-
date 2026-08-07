from __future__ import annotations

import sys
from pathlib import Path

from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import QApplication


def themes_dir() -> Path:
    if getattr(sys, "frozen", False):
        base = Path(sys._MEIPASS)  # type: ignore[attr-defined]
        bundled = base / "arb_desktop" / "ui" / "themes"
        if bundled.is_dir():
            return bundled
    return Path(__file__).resolve().parent / "themes"


def apply_theme(app: QApplication, theme: str = "dark") -> None:
    font = QFont("Segoe UI Variable", 10)
    if not font.exactMatch():
        font = QFont("Inter", 10)
    if not font.exactMatch():
        font = QFont("Segoe UI", 10)
    app.setFont(font)

    name = "theme_light.qss" if theme == "light" else "theme_dark.qss"
    path = themes_dir() / name
    if path.is_file():
        app.setStyleSheet(path.read_text(encoding="utf-8"))
    else:
        app.setStyleSheet("")
