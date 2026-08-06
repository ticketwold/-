from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class LogEntry:
    timestamp: str
    site: str
    status: str
    odds: str
    profit: str
    message: str

    def format_line(self) -> str:
        return f"{self.timestamp} | {self.site} | {self.status} | {self.odds} | {self.profit} | {self.message}"


class LogManager:
    def __init__(self, logs_dir: Path, on_entry: Callable[[LogEntry], None] | None = None) -> None:
        self._logs_dir = logs_dir
        self._logs_dir.mkdir(parents=True, exist_ok=True)
        self._on_entry = on_entry
        self._last_keys: dict[str, str] = {}

    def _log_path(self) -> Path:
        day = datetime.now().strftime("%Y%m%d")
        return self._logs_dir / f"arb-desktop-{day}.log"

    def log(
        self,
        *,
        site: str,
        status: str,
        odds: str = "-",
        profit: str = "-",
        message: str,
        dedup_key: str | None = None,
    ) -> None:
        key = dedup_key or f"{site}|{status}|{odds}|{profit}|{message}"
        if self._last_keys.get(site) == key:
            return
        self._last_keys[site] = key

        entry = LogEntry(
            timestamp=datetime.now().strftime("%H:%M:%S"),
            site=site,
            status=status,
            odds=odds,
            profit=profit,
            message=message,
        )
        line = entry.format_line()
        with self._log_path().open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        if self._on_entry:
            self._on_entry(entry)

    def open_log_file(self) -> Path:
        path = self._log_path()
        if not path.exists():
            path.touch()
        return path
