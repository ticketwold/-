from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger("arb.exec")

STAKE_SYNC_STEPS = (
    "CALCULATE",
    "SEND",
    "CONTENT_RX",
    "INPUT_FOUND",
    "WRITE",
    "VERIFY",
    "ACK",
)

BET_STEPS = (
    "EXECUTION_START",
    "X10_BUTTON_FOUND",
    "BC_BUTTON_FOUND",
    "FINAL_RECHECK",
    "DISPATCH_START",
    "X10_CLICK",
    "BC_CLICK",
    "RESULT",
)


@dataclass
class ExecLogger:
    """Stage-by-stage execution log — GUI + execution-YYYYMMDD.log (not crash.log)."""

    log_dir: Path | None = None
    _listeners: list[Callable[[str, dict[str, Any]], None]] = field(default_factory=list)
    _file_path: Path | None = None
    _first_failure: str | None = None
    _active_flow: str = ""

    def set_log_dir(self, log_dir: Path) -> None:
        self.log_dir = log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        day = datetime.now().strftime("%Y%m%d")
        self._file_path = log_dir / f"execution-{day}.log"

    def add_listener(self, listener: Callable[[str, dict[str, Any]], None]) -> None:
        self._listeners.append(listener)

    def reset_flow(self, flow: str) -> None:
        self._active_flow = flow
        self._first_failure = None

    def _emit(self, line: str, payload: dict[str, Any]) -> str:
        logger.info(line)
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

    def _record_first_failure(self, flow: str, step: str, reason: str) -> None:
        if self._first_failure:
            return
        self._first_failure = f"{flow} / {step} / {reason or 'unknown'}"
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        marker = f"{ts} >>> FIRST_FAILURE <<< {self._first_failure}"
        self._emit(marker, {"stage": "FIRST_FAILURE", "flow": flow, "step": step, "reason": reason})

    def _step_line(
        self,
        flow: str,
        step: str,
        *,
        ok: bool,
        reason: str = "",
        **fields: Any,
    ) -> str:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        status = "PASS" if ok else "FAIL"
        parts = [ts, f"{flow}:", step, status]
        if reason:
            parts.append(f"reason={reason}")
        for key, value in fields.items():
            if value is None or value == "":
                continue
            parts.append(f"{key}={value}")
        line = " ".join(parts)
        payload = {"flow": flow, "step": step, "ok": ok, "reason": reason, **fields}
        if not ok:
            self._record_first_failure(flow, step, reason)
        return self._emit(line, payload)

    def begin_stake_sync(self) -> None:
        self.reset_flow("BC STAKE SYNC")

    def stake_step(self, step: str, *, ok: bool, reason: str = "", **fields: Any) -> str:
        return self._step_line("BC STAKE SYNC", step, ok=ok, reason=reason, **fields)

    def begin_bet(self, *, manual: bool, auto: bool = False) -> None:
        label = "MANUAL BET" if manual else "AUTO BET"
        self.reset_flow(label)
        self._active_flow = label

    def bet_step(self, step: str, *, ok: bool, reason: str = "", **fields: Any) -> str:
        flow = self._active_flow or "MANUAL/AUTO BET"
        return self._step_line(flow, step, ok=ok, reason=reason, **fields)

    @property
    def first_failure(self) -> str | None:
        return self._first_failure

    @property
    def execution_log_path(self) -> Path | None:
        return self._file_path

    def log(self, stage: str, *, ok: bool | None = None, reason: str = "", **fields: Any) -> str:
        """Legacy/generic log line (still written to execution log)."""
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        parts = [ts, f"[{stage}]"]
        if ok is not None:
            parts.append("PASS" if ok else "FAIL")
        if reason:
            parts.append(f"reason={reason}")
        for key, value in fields.items():
            if value is None or value == "":
                continue
            parts.append(f"{key}={value}")
        line = " ".join(parts)
        payload = {"stage": stage, "ok": ok, "reason": reason, **fields}
        if ok is False:
            self._record_first_failure(stage, stage, reason)
        return self._emit(line, payload)


_GLOBAL = ExecLogger()


def get_exec_logger() -> ExecLogger:
    return _GLOBAL


def begin_stake_sync(**fields: Any) -> None:
    get_exec_logger().begin_stake_sync()
    if fields:
        get_exec_logger().stake_step("CALCULATE", ok=True, reason="begin", **fields)


def stake_step(step: str, ok: bool, reason: str = "", **fields: Any) -> str:
    return get_exec_logger().stake_step(step, ok=ok, reason=reason, **fields)


def begin_bet(*, manual: bool, auto: bool = False) -> None:
    get_exec_logger().begin_bet(manual=manual, auto=auto)


def bet_step(step: str, ok: bool, reason: str = "", **fields: Any) -> str:
    return get_exec_logger().bet_step(step, ok=ok, reason=reason, **fields)
