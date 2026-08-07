from __future__ import annotations

import json
import platform
import secrets
from dataclasses import asdict, dataclass, field
from pathlib import Path

from arb_desktop.bridge.pairing_store import PairingStore


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
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        migrated = self._migrate(raw)
        settings = AppSettings(**{k: v for k, v in migrated.items() if k in AppSettings.__dataclass_fields__})
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
        from arb_desktop.config import settings as runtime

        runtime.bridge_host = settings.bridge_host
        runtime.bridge_port = settings.bridge_port
        runtime.bridge_pair_port = settings.bridge_pair_port
        runtime.bridge_token = settings.bridge_credential
        runtime.default_bti_stake_krw = settings.bti_stake_krw
        runtime.min_profit_pct = settings.target_profit_pct
        runtime.default_usdt_rate = settings.usdt_rate
        runtime.dry_run = settings.dry_run
