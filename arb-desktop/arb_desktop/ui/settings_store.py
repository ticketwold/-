from __future__ import annotations

import json
import logging
import platform
import secrets
from dataclasses import asdict, dataclass, field
from pathlib import Path

from arb_desktop.bridge.pairing_store import PairingStore

logger = logging.getLogger(__name__)

# AppSettings field -> runtime Settings (config.py) field
RUNTIME_SETTINGS_MAP: dict[str, str] = {
    "bridge_host": "bridge_host",
    "bridge_port": "bridge_port",
    "bridge_pair_port": "bridge_pair_port",
    "bridge_credential": "bridge_token",
    "bti_stake_krw": "default_bti_stake_krw",
    "target_profit_pct": "min_profit_pct",
    "usdt_rate": "default_usdt_rate",
    "dry_run": "dry_run",
    "live_execution_enabled": "live_execution_enabled",
    "parallel_execution_enabled": "parallel_execution_enabled",
}


def _default_data_dir() -> Path:
    home = Path.home()
    if platform.system() == "Windows":
        return home / "AppData" / "Local" / "arb-desktop"
    if platform.system() == "Darwin":
        return home / "Library" / "Application Support" / "arb-desktop"
    return home / ".config" / "arb-desktop"


@dataclass
class AppSettings:
    target_profit_pct: float = 0.5
    bti_stake_krw: int = 10_000
    usdt_rate: float = 1400.0
    stabilize_seconds: float = 3.0
    stable_count_required: int = 3
    round_unit_krw: int = 100
    round_unit_usdt: float = 0.1
    dry_run: bool = True
    fx_auto_enabled: bool = True
    fx_refresh_seconds: float = 2.0
    fx_max_stale_seconds: float = 30.0
    bet_close_auto_wait: bool = True
    auto_resume_on_recovery: bool = True
    pre_dispatch_verify_ms: float = 100.0
    odds_change_tolerance: float = 0.0
    parallel_execution_enabled: bool = False
    parallel_dry_run_on_ready: bool = True
    stake_sync_enabled: bool = True
    live_execution_enabled: bool = False
    manual_confirm_skip: bool = False
    ui_theme: str = "dark"
    bridge_host: str = "127.0.0.1"
    bridge_port: int = 18765
    bridge_pair_port: int = 18766
    bridge_credential: str = ""
    paired_extension_ids: list[str] = field(default_factory=list)
    last_paired_at: str = ""
    setup_completed: bool = False
    first_run_version: str = ""

    def ensure_credential(self) -> None:
        if not self.bridge_credential:
            self.bridge_credential = secrets.token_urlsafe(32)


class SettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self.data_dir = _default_data_dir()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = path or self.data_dir / "settings.json"
        self.logs_dir = self.data_dir / "logs"
        self.logs_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> AppSettings:
        if not self.path.exists():
            settings = AppSettings(first_run_version="1.5.2")
            settings.ensure_credential()
            self.save(settings)
            return settings
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("settings.json unreadable (%s) — using defaults", exc)
            settings = AppSettings()
            settings.ensure_credential()
            return settings
        if not isinstance(raw, dict):
            logger.warning("settings.json is not an object — using defaults")
            settings = AppSettings()
            settings.ensure_credential()
            return settings
        migrated = self._migrate(raw)
        known = AppSettings.__dataclass_fields__
        filtered: dict = {}
        for key, value in migrated.items():
            if key in known:
                filtered[key] = value
            else:
                logger.warning("Ignoring unknown settings key: %s", key)
        try:
            settings = AppSettings(**filtered)
        except TypeError as exc:
            logger.warning("settings.json partial apply failed (%s) — using defaults + valid keys", exc)
            settings = AppSettings()
            for key, value in filtered.items():
                if key in known:
                    try:
                        setattr(settings, key, value)
                    except (TypeError, ValueError):
                        logger.warning("Skipping invalid settings value for %s", key)
        settings.ensure_credential()
        if migrated != raw:
            self.save(settings)
        return settings

    def _migrate(self, raw: dict) -> dict:
        data = dict(raw)
        if data.get("bridge_token") and not data.get("bridge_credential"):
            data["bridge_credential"] = data.pop("bridge_token")
        data.pop("bridge_token", None)
        if "token_file" in data:
            data.pop("token_file", None)
        if data.get("round_unit_usdt") == 0.01:
            data["round_unit_usdt"] = 0.1
        # Execution defaults for older settings.json without these keys
        data.setdefault("parallel_execution_enabled", False)
        data.setdefault("live_execution_enabled", False)
        data.setdefault("stake_sync_enabled", True)
        return data

    def save(self, settings: AppSettings) -> None:
        payload = asdict(settings)
        payload.pop("bridge_token", None)
        self.path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    def pairing_store_from_settings(self, settings: AppSettings) -> PairingStore:
        store = PairingStore(
            credential=settings.bridge_credential,
            allowed_extension_ids=list(settings.paired_extension_ids),
        )
        if settings.last_paired_at:
            try:
                from datetime import datetime

                dt = datetime.strptime(settings.last_paired_at, "%Y-%m-%d %H:%M:%S")
                store.last_paired_at = dt.timestamp()
            except ValueError:
                pass

        def _persist() -> None:
            settings.bridge_credential = store.credential
            settings.paired_extension_ids = list(store.allowed_extension_ids)
            if store.last_paired_at:
                from datetime import datetime

                settings.last_paired_at = datetime.fromtimestamp(store.last_paired_at).strftime("%Y-%m-%d %H:%M:%S")
            self.save(settings)

        store.on_change = _persist
        return store

    def apply_to_runtime(self, settings: AppSettings) -> None:
        from arb_desktop.config import Settings, settings as runtime

        allowed = set(Settings.model_fields.keys())
        updates: dict[str, object] = {}
        for app_key, runtime_key in RUNTIME_SETTINGS_MAP.items():
            if runtime_key not in allowed:
                logger.warning("Runtime Settings missing field %s — skip", runtime_key)
                continue
            updates[runtime_key] = getattr(settings, app_key)
        # Keep parallel flag in sync when only live_execution is set in older configs
        if settings.live_execution_enabled and not settings.parallel_execution_enabled:
            updates["parallel_execution_enabled"] = True
        for key, value in updates.items():
            if key not in allowed:
                continue
            try:
                object.__setattr__(runtime, key, value)
            except (ValueError, TypeError) as exc:
                logger.warning("Failed to apply runtime setting %s: %s", key, exc)
