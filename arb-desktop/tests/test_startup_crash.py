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
    from arb_desktop.startup_crash import crash_log_path, record_crash, startup_log

    startup_log("[STARTUP 1] test")
    path = record_crash(RuntimeError("test"), stage="unit-test")
    assert path == tmp_path / "arb-desktop" / "crash.log"
    assert path.exists()
    text = path.read_text(encoding="utf-8")
    assert "[STARTUP 1] test" in text
    assert "RuntimeError" in text
