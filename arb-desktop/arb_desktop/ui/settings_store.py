from __future__ import annotations

import json
import platform
import secrets
from dataclasses import asdict, dataclass, field
from pathlib import Path


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
    round_unit_usdt: float = 0.01
    dry_run: bool = True
    bridge_host: str = "127.0.0.1"
    bridge_port: int = 18765
    bridge_token: str = ""
    setup_completed: bool = False
    first_run_version: str = ""

    def ensure_token(self) -> None:
        if not self.bridge_token:
            self.bridge_token = secrets.token_urlsafe(24)


class SettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self.data_dir = _default_data_dir()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = path or self.data_dir / "settings.json"
        self.logs_dir = self.data_dir / "logs"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.token_file = self.data_dir / "bridge_token.txt"

    def load(self) -> AppSettings:
        if not self.path.exists():
            settings = AppSettings()
            settings.ensure_token()
            self.save(settings)
            return settings
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        settings = AppSettings(**{k: v for k, v in raw.items() if k in AppSettings.__dataclass_fields__})
        settings.ensure_token()
        return settings

    def save(self, settings: AppSettings) -> None:
        self.path.write_text(json.dumps(asdict(settings), indent=2, ensure_ascii=False), encoding="utf-8")
        self.token_file.write_text(settings.bridge_token, encoding="utf-8")

    def apply_to_runtime(self, settings: AppSettings) -> None:
        from arb_desktop.config import settings as runtime

        runtime.bridge_host = settings.bridge_host
        runtime.bridge_port = settings.bridge_port
        runtime.bridge_token = settings.bridge_token
        runtime.default_bti_stake_krw = settings.bti_stake_krw
        runtime.min_profit_pct = settings.target_profit_pct
        runtime.default_usdt_rate = settings.usdt_rate
        runtime.dry_run = settings.dry_run
