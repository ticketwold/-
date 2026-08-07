from __future__ import annotations

import json
import os
from unittest.mock import patch

import pytest

from arb_desktop.config import Settings
from arb_desktop.ui.settings_store import RUNTIME_SETTINGS_MAP, AppSettings, SettingsStore


def test_runtime_map_targets_defined_settings_fields() -> None:
    runtime_fields = set(Settings.model_fields.keys())
    used_runtime_fields = set(RUNTIME_SETTINGS_MAP.values())
    missing = used_runtime_fields - runtime_fields
    assert not missing, f"Runtime Settings missing fields used by apply_to_runtime: {missing}"


def test_apply_to_runtime_does_not_crash() -> None:
    store = SettingsStore()
    app = AppSettings(
        live_execution_enabled=True,
        parallel_execution_enabled=True,
        dry_run=False,
    )
    store.apply_to_runtime(app)
    from arb_desktop.config import settings as runtime

    assert runtime.live_execution_enabled is True
    assert runtime.parallel_execution_enabled is True
    assert runtime.dry_run is False


def test_load_empty_settings_json(tmp_path) -> None:
    path = tmp_path / "settings.json"
    path.write_text("{}", encoding="utf-8")
    store = SettingsStore(path=path)
    settings = store.load()
    assert settings.parallel_execution_enabled is False
    assert settings.live_execution_enabled is False
    assert settings.stake_sync_enabled is True
    assert settings.bridge_credential


def test_load_legacy_v15_without_execution_flags(tmp_path) -> None:
    path = tmp_path / "settings.json"
    legacy = {
        "target_profit_pct": 1.0,
        "bti_stake_krw": 50000,
        "usdt_rate": 1350.0,
        "dry_run": True,
        "bridge_host": "127.0.0.1",
        "bridge_port": 18765,
        "bridge_pair_port": 18766,
        "bridge_credential": "legacy-token",
        "ui_theme": "dark",
    }
    path.write_text(json.dumps(legacy), encoding="utf-8")
    store = SettingsStore(path=path)
    settings = store.load()
    store.apply_to_runtime(settings)
    assert settings.parallel_execution_enabled is False
    assert settings.live_execution_enabled is False
    assert settings.stake_sync_enabled is True


def test_load_with_unknown_fields(tmp_path) -> None:
    path = tmp_path / "settings.json"
    payload = {
        "target_profit_pct": 0.5,
        "unknown_future_field": "should-be-ignored",
        "another_unknown": 123,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    store = SettingsStore(path=path)
    settings = store.load()
    store.apply_to_runtime(settings)
    assert settings.target_profit_pct == 0.5


def test_load_invalid_json_uses_defaults(tmp_path) -> None:
    path = tmp_path / "settings.json"
    path.write_text("{not-json", encoding="utf-8")
    store = SettingsStore(path=path)
    settings = store.load()
    store.apply_to_runtime(settings)
    assert isinstance(settings, AppSettings)


def test_load_new_settings_with_parallel_flag(tmp_path) -> None:
    path = tmp_path / "settings.json"
    payload = {
        "parallel_execution_enabled": True,
        "live_execution_enabled": True,
        "stake_sync_enabled": False,
        "dry_run": False,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")
    store = SettingsStore(path=path)
    settings = store.load()
    store.apply_to_runtime(settings)
    from arb_desktop.config import settings as runtime

    assert settings.parallel_execution_enabled is True
    assert settings.live_execution_enabled is True
    assert settings.stake_sync_enabled is False
    assert runtime.parallel_execution_enabled is True


@pytest.mark.skipif(
    not os.environ.get("DISPLAY") and os.environ.get("QT_QPA_PLATFORM") != "offscreen",
    reason="GUI display not available",
)
def test_main_window_init_offscreen(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("QT_QPA_PLATFORM", "offscreen")
    path = tmp_path / "settings.json"
    path.write_text("{}", encoding="utf-8")

    try:
        from PyQt6.QtWidgets import QApplication
    except ImportError as exc:
        pytest.skip(f"PyQt6 unavailable: {exc}")

    app = QApplication.instance() or QApplication([])

    with patch("arb_desktop.ui.main_window.SettingsStore") as mock_cls:
        store = SettingsStore(path=path)
        mock_cls.return_value = store
        from arb_desktop.ui.main_window import MainWindow

        win = MainWindow()
        assert win._settings is not None
        win.close()
        app.processEvents()
