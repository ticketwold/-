"""Material Design icons via qtawesome with safe fallback."""

from __future__ import annotations

from PyQt6.QtGui import QIcon

try:
    import qtawesome as qta

    _HAS_QTA = True
except ImportError:
    _HAS_QTA = False

_ICON_MAP = {
    "bridge": "mdi.wifi",
    "fx": "mdi.currency-usd",
    "odds": "mdi.trending-up",
    "ready": "mdi.check-circle",
    "bet": "mdi.lightning-bolt",
    "log": "mdi.console",
    "bc": "mdi.alpha-b-circle",
    "x10": "mdi.numeric-10-circle",
    "watch": "mdi.eye",
    "settings": "mdi.cog",
}


def icon(name: str, color: str = "#A8B0BE", size: int = 18) -> QIcon:
    if _HAS_QTA:
        glyph = _ICON_MAP.get(name, "mdi.circle")
        return qta.icon(glyph, color=color)
    return QIcon()
