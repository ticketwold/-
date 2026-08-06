from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ARB_", env_file=".env", extra="ignore")

    # Sites
    bti_wrapper_url: str = "https://www.x10x10s.com"
    bc_sports_url: str = "https://bc.game/sports"

    # Polling / latency targets (ms)
    scan_interval_ms: int = 100
    network_timeout_ms: int = 800
    playwright_timeout_ms: int = 2500
    ocr_timeout_ms: int = 4000

    # Trading
    default_bti_stake_krw: int = 10_000
    default_usdt_rate: float = 1400.0
    min_profit_pct: float = 0.5

    # BetSlip-first mode (전체 경기 스캔 비활성화)
    betslip_first_mode: bool = True
    betslip_network_tolerance: float = 0.06
    dry_run: bool = True
    live_execution_enabled: bool = False
    auto_retry_max: int = 3

    # Browser
    headless: bool = False
    user_data_dir: Path = Path.home() / ".arb-desktop" / "browser-profile"
    persist_sessions: bool = True

    # BTI API
    bti_market_types: str = "ML0,HC0,OU0"
    bti_language: str = "KO"
    bti_minimum_odds: float = 1.1

    # BC network tap URL patterns
    bc_url_patterns: tuple[str, ...] = (
        "betby",
        "slip",
        "sport",
        "wager",
        "stake",
        "odd",
        "coupon",
        "ticket",
        "sptsportscdn",
        "sptpub",
        "selection",
        "bc.game",
        "api/v4/live",
        "api/v4/prematch",
        "ws",
        "websocket",
    )


settings = Settings()
