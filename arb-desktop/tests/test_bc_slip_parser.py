from __future__ import annotations

import pytest

from arb_desktop.betslip.parsers.bc_text import parse_bc_selection_text


ORIOLES_TEXT = "볼티모어 오리올스 볼티모어 오리올스 vs LA에인절스 승자(연장전 포함) 2.7"


def test_bc_orioles_fixture():
    r = parse_bc_selection_text(ORIOLES_TEXT, stake=5)
    assert r.event == "볼티모어 오리올스 vs LA 에인절스"
    assert r.market == "승자(연장전 포함)"
    assert r.market_normalized == "Moneyline"
    assert r.selection == "볼티모어 오리올스"
    assert r.odds == 2.7
    assert r.status == "active"


def test_bc_stake_excluded_from_odds():
    r = parse_bc_selection_text("Team A vs Team B 승자 5", stake=5)
    assert r.odds is None
    assert r.status == "odds_missing"


def test_bc_trailing_odds_only():
    r = parse_bc_selection_text("Samsung vs LG 승자 2.15", stake=10000)
    assert r.odds == 2.15
