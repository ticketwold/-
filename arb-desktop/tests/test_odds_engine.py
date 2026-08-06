import pytest

from arb_desktop.core.odds_engine import OddsEngine, calc_arb, calc_bc_stake_usdt
from arb_desktop.core.team_matcher import matchup_teams_match, team_match
from arb_desktop.models import Matchup, MoneylineSelection, SiteId


def test_calc_arb_profitable():
    assert calc_arb(2.1, 2.1) is not None
    assert calc_arb(1.5, 1.5) is None


def test_calc_bc_stake():
    stake = calc_bc_stake_usdt(10000, 2.0, 2.1, 1400)
    assert 6.5 < stake < 7.0


def test_team_match():
    assert team_match("T1", "T1 Esports")
    assert team_match("Gen.G", "GenG")


def test_matchup_align():
    assert matchup_teams_match("T1", "Gen.G", "T1", "Gen.G")
    assert matchup_teams_match("T1", "Gen.G", "Gen.G", "T1")  # reversed


def test_find_opportunities():
    bti = Matchup(
        site=SiteId.BTI_X10,
        event_id="1",
        home="Team Alpha",
        away="Team Beta",
        moneyline=[
            MoneylineSelection("Team Alpha", "H", 2.2, captured_ns=0),
            MoneylineSelection("Team Beta", "A", 1.7, captured_ns=0),
        ],
    )
    bc = Matchup(
        site=SiteId.BC_GAME,
        event_id="1",
        home="Team Alpha",
        away="Team Beta",
        moneyline=[
            MoneylineSelection("Team Alpha", "", 2.5, captured_ns=0),
            MoneylineSelection("Team Beta", "", 1.6, captured_ns=0),
        ],
    )
    engine = OddsEngine(min_profit_pct=0.1, bti_stake_krw=10000, usdt_rate=1400)
    opps = engine.find_opportunities([bti], [bc])
    assert len(opps) >= 1
    assert opps[0].profit_pct > 0
