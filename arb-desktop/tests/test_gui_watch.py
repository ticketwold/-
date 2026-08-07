from __future__ import annotations

import time
from pathlib import Path

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus
from arb_desktop.market_data.bithumb_fx import FxSnapshot, FxStatus
from arb_desktop.ui.settings_store import AppSettings
from arb_desktop.ui.watch_engine import WatchEngine, WatchState


def _fx(rate: float = 1400.0) -> FxSnapshot:
    return FxSnapshot(rate=rate, status=FxStatus.LIVE, updated_at=time.time(), age_seconds=0.5)


def test_settings_roundtrip(tmp_path: Path) -> None:
    from arb_desktop.ui.settings_store import SettingsStore

    store = SettingsStore(path=tmp_path / "settings.json")
    store.logs_dir = tmp_path / "logs"
    s = AppSettings(target_profit_pct=1.5, bti_stake_krw=20000, bridge_credential="abc")
    store.save(s)
    loaded = store.load()
    assert loaded.target_profit_pct == 1.5
    assert loaded.bti_stake_krw == 20000
    assert loaded.bridge_credential == "abc"
    assert loaded.round_unit_usdt == 0.1


def test_settings_migrates_bridge_token(tmp_path: Path) -> None:
    from arb_desktop.ui.settings_store import SettingsStore

    path = tmp_path / "settings.json"
    path.write_text('{"bridge_token": "legacy-token", "target_profit_pct": 1.0}', encoding="utf-8")
    store = SettingsStore(path=path)
    store.logs_dir = tmp_path / "logs"
    loaded = store.load()
    assert loaded.bridge_credential == "legacy-token"
    assert "bridge_token" not in path.read_text(encoding="utf-8")


def test_watch_engine_ready_without_event_match() -> None:
    engine = WatchEngine()
    engine.start_watch(user_confirmed=True)
    settings = AppSettings(
        target_profit_pct=0.1,
        bti_stake_krw=10000,
        stabilize_seconds=0,
        stable_count_required=1,
        fx_auto_enabled=False,
        usdt_rate=1400.0,
    )
    bc = BetSlipReadResult(
        site="bc",
        ok=True,
        empty=False,
        items=[
            BetSlipItem(
                site="bc",
                event="A vs B",
                market="승패",
                selection="B팀 승",
                odds=2.1,
                status=SlipStatus.ACTIVE,
            )
        ],
    )
    bti = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=False,
        items=[
            BetSlipItem(
                site="bti",
                event="A vs B",
                market="승패",
                selection="A팀 승",
                odds=2.05,
                status=SlipStatus.ACTIVE,
            )
        ],
    )
    state, metrics, err = engine.tick(
        bridge_connected=True,
        bc=bc,
        bti=bti,
        settings=settings,
        fx=_fx(),
        user_confirmed=True,
    )
    assert err in (None, "ready")
    assert state == WatchState.READY
    assert metrics.current_profit_rate > 0


def test_watch_engine_blocks_event_parse_reasons() -> None:
    engine = WatchEngine()
    engine.start_watch(user_confirmed=True)
    settings = AppSettings(target_profit_pct=0.1, bti_stake_krw=10000, fx_auto_enabled=False, usdt_rate=1400.0)
    bc = BetSlipReadResult(
        site="bc",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bc", odds=2.1, status=SlipStatus.ACTIVE)],
    )
    bti = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bti", odds=2.05, status=SlipStatus.ACTIVE)],
    )
    _, _, err = engine.tick(
        bridge_connected=True,
        bc=bc,
        bti=bti,
        settings=settings,
        fx=_fx(),
        user_confirmed=True,
    )
    assert err != "event-parse-incomplete"
    assert err != "unknown-market"


def test_watch_engine_auto_bet_wait_on_closed_site() -> None:
    engine = WatchEngine()
    engine.start_watch(user_confirmed=True)
    settings = AppSettings(
        target_profit_pct=0.1,
        bti_stake_krw=10000,
        stabilize_seconds=0,
        stable_count_required=1,
        fx_auto_enabled=False,
        usdt_rate=1400.0,
        bet_close_auto_wait=True,
    )
    bc = BetSlipReadResult(
        site="bc",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bc", event="", market="", selection="", odds=2.1, status=SlipStatus.ACTIVE)],
    )
    bti = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bti", event="", market="", selection="", odds=2.05, status=SlipStatus.CLOSED)],
    )
    engine._site_debounce._confirmed["x10"] = SlipStatus.CLOSED
    state, _, err = engine.tick(
        bridge_connected=True,
        bc=bc,
        bti=bti,
        settings=settings,
        fx=_fx(),
        user_confirmed=True,
    )
    assert state == WatchState.AUTO_BET_WAIT
    assert err == "auto-bet-wait"


def test_watch_engine_recovers_after_closed() -> None:
    engine = WatchEngine()
    engine.start_watch(user_confirmed=True)
    settings = AppSettings(
        target_profit_pct=0.1,
        bti_stake_krw=10000,
        stabilize_seconds=0,
        stable_count_required=1,
        fx_auto_enabled=False,
        usdt_rate=1400.0,
        bet_close_auto_wait=True,
        auto_resume_on_recovery=True,
    )
    bc = BetSlipReadResult(
        site="bc",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bc", market="승패", selection="B팀 승", odds=2.1, status=SlipStatus.ACTIVE)],
    )
    bti_closed = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bti", market="승패", selection="A팀 승", odds=2.05, status=SlipStatus.CLOSED)],
    )
    bti_active = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bti", market="승패", selection="A팀 승", odds=2.05, status=SlipStatus.ACTIVE)],
    )
    engine._site_debounce._confirmed["x10"] = SlipStatus.CLOSED
    engine.tick(
        bridge_connected=True,
        bc=bc,
        bti=bti_closed,
        settings=settings,
        fx=_fx(),
        user_confirmed=True,
    )
    assert engine.state == WatchState.AUTO_BET_WAIT
    engine._site_debounce._confirmed["x10"] = SlipStatus.ACTIVE
    engine._site_debounce._confirmed["bc"] = SlipStatus.ACTIVE
    state, _, _ = engine.tick(
        bridge_connected=True,
        bc=bc,
        bti=bti_active,
        settings=settings,
        fx=_fx(),
        user_confirmed=True,
    )
    assert state in {WatchState.TARGET_WAIT, WatchState.STABILIZING, WatchState.READY}
