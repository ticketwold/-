from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger("arb.exec")


@dataclass
class ExecLogger:
    """Stage-by-stage execution log — GUI + file."""

    log_dir: Path | None = None
    _listeners: list[Callable[[str, dict[str, Any]], None]] = field(default_factory=list)
    _file_path: Path | None = None

    def set_log_dir(self, log_dir: Path) -> None:
        self.log_dir = log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        day = datetime.now().strftime("%Y-%m-%d")
        self._file_path = log_dir / f"exec-{day}.log"

    def add_listener(self, listener: Callable[[str, dict[str, Any]], None]) -> None:
        self._listeners.append(listener)

    def log(self, stage: str, *, ok: bool | None = None, reason: str = "", **fields: Any) -> str:
        parts = [f"[EXEC]", f"stage={stage}"]
        if ok is not None:
            parts.append(f"ok={'true' if ok else 'false'}")
        if reason:
            parts.append(f"reason={reason}")
        for key, value in fields.items():
            if value is None or value == "":
                continue
            parts.append(f"{key}={value}")
        line = " ".join(parts)
        logger.info(line)
        payload = {"stage": stage, "ok": ok, "reason": reason, **fields}
        if self._file_path:
            try:
                with self._file_path.open("a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except OSError:
                pass
        for listener in self._listeners:
            try:
                listener(line, payload)
            except Exception:
                pass
        return line


_GLOBAL = ExecLogger()


def get_exec_logger() -> ExecLogger:
    return _GLOBAL
