from __future__ import annotations

import json

from arb_desktop.config import Settings
from arb_desktop.ui.settings_store import RUNTIME_SETTINGS_MAP, AppSettings, SettingsStore


def test_runtime_map_targets_defined_settings_fields() -> None:
    runtime_fields = set(Settings.model_fields.keys())
    used_runtime_fields = set(RUNTIME_SETTINGS_MAP.values())
    missing = used_runtime_fields - runtime_fields
    assert not missing, f"Runtime Settings missing fields: {missing}"


def test_runtime_settings_has_execution_flags() -> None:
    fields = Settings.model_fields
    for name in (
        "live_execution_enabled",
        "parallel_execution_enabled",
        "dry_run",
        "odds_only_mode",
        "betslip_first_mode",
    ):
        assert name in fields, f"Settings model missing {name}"


def test_app_settings_has_gui_flags() -> None:
    names = {f.name for f in AppSettings.__dataclass_fields__.values()}
    for name in (
        "stake_sync_enabled",
        "live_execution_enabled",
        "parallel_execution_enabled",
        "manual_confirm_skip",
        "auto_resume_on_recovery",
    ):
        assert name in names, f"AppSettings missing {name}"


def test_load_wrong_types_uses_coercion(tmp_path) -> None:
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "bti_stake_krw": "10000",
                "dry_run": "true",
                "parallel_execution_enabled": 1,
                "unknown_field": "ignored",
            }
        ),
        encoding="utf-8",
    )
    store = SettingsStore(path=path)
    settings = store.load()
    store.apply_to_runtime(settings)
    assert settings.bti_stake_krw == 10000
    assert settings.dry_run is True
    assert settings.parallel_execution_enabled is True


def test_startup_crash_log_path_windows(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    from arb_desktop.startup_crash import crash_log_path, log_thread, record_crash, startup_log

    startup_log("[STARTUP 1] test")
    log_thread("MAIN")
    path = record_crash(RuntimeError("test"), stage="unit-test")
    assert path == tmp_path / "arb-desktop" / "crash.log"
    assert path.exists()
    text = path.read_text(encoding="utf-8")
    assert "[STARTUP 1] test" in text
    assert "[THREAD MAIN]" in text
    assert "RuntimeError" in text


def test_show_crash_dialog_is_non_modal(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    try:
        from PyQt6.QtWidgets import QApplication, QMessageBox
    except ImportError:
        import pytest

        pytest.skip("PyQt6 unavailable")

    from arb_desktop.startup_crash import crash_log_path, show_crash_dialog

    app = QApplication.instance() or QApplication([])
    calls: list[str] = []
    original_open = QMessageBox.open
    original_critical = QMessageBox.critical

    def track_open(self) -> None:
        calls.append("open")
        original_open(self)

    monkeypatch.setattr(QMessageBox, "open", track_open)
    monkeypatch.setattr(
        QMessageBox,
        "critical",
        lambda *a, **k: calls.append("critical") or original_critical(*a, **k),
    )
    show_crash_dialog(RuntimeError("freeze-test"), crash_log_path(), stage="test")
    app.processEvents()
    assert "open" in calls
    assert "critical" not in calls


def test_main_window_defers_background_thread(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    path = tmp_path / "settings.json"
    path.write_text("{}", encoding="utf-8")

    try:
        from PyQt6.QtWidgets import QApplication
    except ImportError:
        import pytest

        pytest.skip("PyQt6 unavailable")

    from unittest.mock import MagicMock, patch

    app = QApplication.instance() or QApplication([])

    with patch("arb_desktop.ui.main_window.SettingsStore") as mock_cls:
        store = SettingsStore(path=path)
        mock_cls.return_value = store
        from arb_desktop.ui.main_window import MainWindow

        win = MainWindow(store=store, settings=store.load())
        assert not win._background_started
        started = MagicMock()
        win._thread.start = started
        win.start_background_services()
        assert win._background_started
        started.assert_called_once()
        win.close()
        app.processEvents()
