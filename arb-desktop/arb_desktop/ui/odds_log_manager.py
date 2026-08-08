from __future__ import annotations

import csv
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable


MAX_MEMORY_ENTRIES = 5000

CSV_COLUMNS = (
    "timestamp",
    "site",
    "previous_odds",
    "current_odds",
    "status",
    "watch_enabled",
    "profit_rate",
    "message",
)


@dataclass(frozen=True)
class OddsLogEntry:
    timestamp: str
    display_time: str
    site: str
    previous_odds: str
    current_odds: str
    status: str
    watch_enabled: bool
    profit_rate: str
    message: str

    def csv_row(self) -> list[str]:
        return [
            self.timestamp,
            self.site,
            self.previous_odds,
            self.current_odds,
            self.status,
            "true" if self.watch_enabled else "false",
            self.profit_rate,
            self.message,
        ]

    def display_columns(self) -> tuple[str, ...]:
        watch = "WATCH ON" if self.watch_enabled else "WATCH OFF"
        return (
            self.display_time,
            self.site,
            self.previous_odds,
            self.current_odds,
            self.status,
            self.profit_rate,
            f"{watch} | {self.message}" if self.message else watch,
        )


class OddsLogManager:
    """배당 전용 로그 — 메모리 5,000줄 + 일별 CSV 저장."""

    def __init__(self, logs_dir: Path, on_entry: Callable[[OddsLogEntry], None] | None = None) -> None:
        self._logs_dir = logs_dir
        self._logs_dir.mkdir(parents=True, exist_ok=True)
        self._on_entry = on_entry
        self._entries: deque[OddsLogEntry] = deque(maxlen=MAX_MEMORY_ENTRIES)
        self._last_site_key: dict[str, str] = {}
        self._last_engine_key: str = ""
        self._site_snapshot: dict[str, tuple[str, str]] = {}

    def _csv_path(self) -> Path:
        day = datetime.now().strftime("%Y%m%d")
        return self._logs_dir / f"odds-{day}.csv"

    def _append(self, entry: OddsLogEntry, *, dedup_key: str | None = None) -> None:
        if dedup_key is not None:
            bucket = "ENGINE" if entry.site in {"ENGINE", "APP"} else entry.site
            if self._last_site_key.get(bucket) == dedup_key:
                return
            self._last_site_key[bucket] = dedup_key

        self._entries.append(entry)
        path = self._csv_path()
        write_header = not path.exists()
        with path.open("a", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            if write_header:
                writer.writerow(CSV_COLUMNS)
            writer.writerow(entry.csv_row())
        if self._on_entry:
            self._on_entry(entry)

    def _now(self) -> tuple[str, str]:
        now = datetime.now()
        return now.strftime("%Y-%m-%d %H:%M:%S"), now.strftime("%H:%M:%S")

    def log_site_change(
        self,
        *,
        site: str,
        previous_odds: float | None,
        current_odds: float | None,
        previous_status: str,
        current_status: str,
        watch_enabled: bool,
        profit_rate: float | None,
        message: str = "",
    ) -> None:
        prev_o = self._fmt_odds(previous_odds)
        curr_o = self._fmt_odds(current_odds)
        odds_changed = prev_o != curr_o
        status_changed = previous_status != current_status
        if not odds_changed and not status_changed:
            return

        if not message:
            if odds_changed and status_changed:
                message = "odds_and_status_changed"
            elif odds_changed:
                message = "odds_changed"
            else:
                message = "status_changed"

        key = f"{site}|{prev_o}|{curr_o}|{current_status}|{message}"
        if self._last_site_key.get(site) == key:
            return
        self._last_site_key[site] = key

        ts, display = self._now()
        entry = OddsLogEntry(
            timestamp=ts,
            display_time=display,
            site=site,
            previous_odds=prev_o,
            current_odds=curr_o,
            status=current_status,
            watch_enabled=watch_enabled,
            profit_rate=self._fmt_profit(profit_rate),
            message=message,
        )
        self._append(entry)
        self._site_snapshot[site] = (curr_o, current_status)

    def observe_site(
        self,
        *,
        site: str,
        odds: float | None,
        status: str,
        watch_enabled: bool,
        profit_rate: float | None,
        status_reason: str = "",
        display_odds: float | None = None,
    ) -> None:
        prev_o, prev_s = self._site_snapshot.get(site, ("-", status))
        curr_o = self._fmt_odds(odds if odds is not None else display_odds)
        if prev_o == curr_o and prev_s == status:
            return
        message = status_reason or ""
        if prev_s != status and prev_s not in {"", "-"}:
            if message:
                message = f"{prev_s} → {status} | {message}"
            else:
                message = f"{prev_s} → {status}"
        self.log_site_change(
            site=site,
            previous_odds=None if prev_o == "-" else _parse_odds(prev_o),
            current_odds=odds if odds is not None else display_odds,
            previous_status=prev_s,
            current_status=status,
            watch_enabled=watch_enabled,
            profit_rate=profit_rate,
            message=message,
        )

    def log_watch(self, *, enabled: bool) -> None:
        ts, display = self._now()
        entry = OddsLogEntry(
            timestamp=ts,
            display_time=display,
            site="APP",
            previous_odds="-",
            current_odds="-",
            status="WATCH ON" if enabled else "WATCH OFF",
            watch_enabled=enabled,
            profit_rate="-",
            message="자동감시 시작" if enabled else "자동감시 중지",
        )
        self._append(entry, dedup_key=f"watch|{enabled}")

    def log_engine(
        self,
        *,
        status: str,
        watch_enabled: bool,
        profit_rate: float | None,
        message: str,
    ) -> None:
        key = f"{status}|{message}|{self._fmt_profit(profit_rate)}|{watch_enabled}"
        if self._last_engine_key == key:
            return
        self._last_engine_key = key
        ts, display = self._now()
        entry = OddsLogEntry(
            timestamp=ts,
            display_time=display,
            site="ENGINE",
            previous_odds="-",
            current_odds="-",
            status=status,
            watch_enabled=watch_enabled,
            profit_rate=self._fmt_profit(profit_rate),
            message=message,
        )
        self._append(entry, dedup_key=key)

    def entries(self) -> list[OddsLogEntry]:
        return list(self._entries)

    def clear_memory(self) -> None:
        self._entries.clear()

    def export_csv(self, dest: Path) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(CSV_COLUMNS)
            for entry in self._entries:
                writer.writerow(entry.csv_row())
        return dest

    def open_today_csv(self) -> Path:
        path = self._csv_path()
        if not path.exists():
            with path.open("w", encoding="utf-8", newline="") as fh:
                csv.writer(fh).writerow(CSV_COLUMNS)
        return path

    @staticmethod
    def _fmt_odds(value: float | None) -> str:
        if value is None:
            return "-"
        return f"{value:.3f}"

    @staticmethod
    def _fmt_profit(value: float | None) -> str:
        if value is None:
            return "-"
        return f"{value:.2f}%"


def _parse_odds(text: str) -> float | None:
    try:
        return float(text)
    except (TypeError, ValueError):
        return None
