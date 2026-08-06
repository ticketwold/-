from __future__ import annotations

from pathlib import Path

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.watch_engine import WatchEngine, WatchState


def test_settings_roundtrip(tmp_path: Path) -> None:
    from arb_desktop.ui.settings_store import SettingsStore

    store = SettingsStore(path=tmp_path / "settings.json")
    store.logs_dir = tmp_path / "logs"
    s = AppSettings(target_profit_pct=1.5, bti_stake_krw=20000, bridge_token="abc")
    store.save(s)
    loaded = store.load()
    assert loaded.target_profit_pct == 1.5
    assert loaded.bti_stake_krw == 20000
    assert loaded.bridge_token == "abc"


def test_watch_engine_ready_flow() -> None:
    engine = WatchEngine()
    engine.start_watch()
    settings = AppSettings(target_profit_pct=0.1, bti_stake_krw=10000, stabilize_seconds=0, stable_count_required=1)
    bc = BetSlipReadResult(
        site="bc",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bc", event="Team A vs Team B", market="Moneyline", selection="Team A", odds=2.1, status=SlipStatus.ACTIVE)],
    )
    bti = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bti", event="Team A vs Team B", market="Moneyline", selection="Team B", odds=2.05, status=SlipStatus.ACTIVE)],
    )
    state, metrics, err = engine.tick(bridge_connected=True, bc=bc, bti=bti, settings=settings)
    assert err is None
    assert state == WatchState.READY
    assert metrics.min_guaranteed_profit_pct > 0
