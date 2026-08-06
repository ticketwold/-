from __future__ import annotations

from pathlib import Path

_JS_DIR = Path(__file__).resolve().parent.parent / "js"


def load_js(name: str) -> str:
    path = _JS_DIR / name
    return path.read_text(encoding="utf-8")
