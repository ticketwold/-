#!/usr/bin/env python3
"""양방 배팅 데스크톱 — 엔트리포인트."""

from __future__ import annotations

import sys
import traceback


def main() -> int:
    from arb_desktop.startup_crash import install_global_hooks, record_crash, show_crash_dialog, startup_log

    install_global_hooks()
    try:
        startup_log("[STARTUP 1] import modules")
        from arb_desktop.config import settings as runtime_settings

        startup_log("[STARTUP 2] load Settings")
        _ = runtime_settings.scan_interval_ms

        startup_log("[STARTUP 3] load settings.json")
        from arb_desktop.ui.settings_store import SettingsStore

        store = SettingsStore()
        app_settings = store.load()
        store.apply_to_runtime(app_settings)

        from arb_desktop.ui.main_window import run_app

        return run_app(preloaded_store=store, preloaded_settings=app_settings)
    except Exception as exc:
        log_path = record_crash(exc, stage="main", tb=sys.exc_info()[2])
        traceback.print_exc()
        show_crash_dialog(exc, log_path, stage="main")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
