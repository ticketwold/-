"""Startup crash logging — windowed PyInstaller builds keep traceback + dialog."""

from __future__ import annotations

import os
import sys
import threading
import traceback
from datetime import datetime
from pathlib import Path
from types import TracebackType


def crash_log_path() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "arb-desktop" / "crash.log"
    return Path.home() / ".config" / "arb-desktop" / "crash.log"


def startup_log(message: str) -> None:
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}\n"
    path = crash_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(line)
    try:
        print(line, end="", file=sys.stderr)
    except OSError:
        pass


def log_thread(label: str) -> None:
    """Log thread id for startup diagnostics (MAIN / BRIDGE / FX / SCANNER)."""
    tid = threading.get_ident()
    startup_log(f"[THREAD {label}] id={tid}")


def is_gui_thread() -> bool:
    try:
        from PyQt6.QtCore import QCoreApplication, QThread

        app = QCoreApplication.instance()
        if app is None:
            return False
        return QThread.currentThread() is app.thread()
    except Exception:
        return False


def record_crash(
    exc: BaseException,
    *,
    stage: str = "",
    tb: TracebackType | None = None,
) -> Path:
    path = crash_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"\n{'=' * 72}\n"
        f"{datetime.now().isoformat(timespec='seconds')}  stage={stage or 'unknown'}\n"
    )
    with path.open("a", encoding="utf-8") as f:
        f.write(header)
        f.write(f"{type(exc).__name__}: {exc}\n")
        if tb is not None:
            traceback.print_exception(type(exc), exc, tb, file=f)
        else:
            traceback.print_exc(file=f)
    return path


def show_crash_dialog(exc: BaseException, log_path: Path, *, stage: str = "") -> None:
    """Non-modal startup error — never call QMessageBox.exec() here."""

    def _present() -> None:
        try:
            from PyQt6.QtWidgets import QApplication, QMessageBox

            app = QApplication.instance()
            if app is None:
                app = QApplication(sys.argv)
            title = "ARB DESKTOP — Startup Error"
            body = (
                f"Exception type: {type(exc).__name__}\n\n"
                f"Message:\n{exc}\n\n"
                f"Stage: {stage or 'unknown'}\n\n"
                f"Full traceback saved to:\n{log_path}"
            )
            box = QMessageBox()
            box.setIcon(QMessageBox.Icon.Critical)
            box.setWindowTitle(title)
            box.setText(body)
            box.setStandardButtons(QMessageBox.StandardButton.Ok)
            box.setModal(False)
            box.open()
            app.processEvents()
        except Exception:
            pass

    try:
        from PyQt6.QtCore import QCoreApplication, QThread, QTimer

        app = QCoreApplication.instance()
        if app is None:
            _present()
            return
        if QThread.currentThread() is app.thread():
            _present()
        else:
            QTimer.singleShot(0, _present)
    except Exception:
        _present()


def install_global_hooks() -> None:
    def _sys_hook(exc_type, exc, tb) -> None:
        if exc_type is KeyboardInterrupt:
            sys.__excepthook__(exc_type, exc, tb)
            return
        path = record_crash(exc, stage="sys.excepthook", tb=tb)
        show_crash_dialog(exc, path, stage="sys.excepthook")

    sys.excepthook = _sys_hook

    try:
        from PyQt6.QtCore import qInstallMessageHandler

        def _qt_handler(mode, context, message) -> None:  # type: ignore[no-untyped-def]
            if "fatal" in str(message).lower():
                startup_log(f"[QT FATAL] {message}")

        qInstallMessageHandler(_qt_handler)
    except Exception:
        pass
