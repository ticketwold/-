from __future__ import annotations

from pathlib import Path

from arb_desktop.ui.odds_log_manager import OddsLogManager


def test_odds_log_watch_on_off(tmp_path: Path) -> None:
    mgr = OddsLogManager(tmp_path)
    mgr.log_watch(enabled=True)
    mgr.log_watch(enabled=False)
    assert len(mgr.entries()) == 2
    assert mgr.entries()[0].site == "APP"
    assert mgr.entries()[0].status == "WATCH ON"


def test_odds_log_dedup_same_odds(tmp_path: Path) -> None:
    mgr = OddsLogManager(tmp_path)
    mgr.observe_site(site="X10", odds=2.13, status="ACTIVE", watch_enabled=True, profit_rate=-5.06)
    mgr.observe_site(site="X10", odds=2.13, status="ACTIVE", watch_enabled=True, profit_rate=-5.06)
    assert len(mgr.entries()) == 1


def test_odds_log_odds_change(tmp_path: Path) -> None:
    mgr = OddsLogManager(tmp_path)
    mgr.observe_site(site="BC", odds=1.72, status="ACTIVE", watch_enabled=True, profit_rate=-5.06)
    mgr.observe_site(site="BC", odds=1.76, status="ACTIVE", watch_enabled=True, profit_rate=-1.92)
    assert len(mgr.entries()) == 2
    assert mgr.entries()[1].previous_odds == "1.720"
    assert mgr.entries()[1].current_odds == "1.760"


def test_odds_log_status_change(tmp_path: Path) -> None:
    mgr = OddsLogManager(tmp_path)
    mgr.observe_site(site="BC", odds=1.72, status="ACTIVE", watch_enabled=True, profit_rate=-5.06)
    mgr.observe_site(site="BC", odds=1.72, status="CLOSED", watch_enabled=True, profit_rate=None)
    assert len(mgr.entries()) == 2
    assert mgr.entries()[1].status == "CLOSED"
