from __future__ import annotations

import pytest

from arb_desktop.betslip.format import format_betslip_block, format_odds, format_stake
from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus


def test_format_betslip_block():
    item = BetSlipItem(
        site="BC.Game",
        event="Team A vs Team B",
        selection="Team B",
        odds=1.95,
        status=SlipStatus.ACTIVE,
        stake=10.5,
    )
    block = format_betslip_block(item)
    assert "[BETSLIP]" in block
    assert "site: BC.Game" in block
    assert "event: Team A vs Team B" in block
    assert "selection: Team B" in block
    assert "odds: 1.95" in block
    assert "status: active" in block
    assert "stake: 10.5" in block


def test_format_odds_and_stake():
    assert format_odds(None) == "-"
    assert format_odds(2.0) == "2"
    assert format_stake(None) == "-"
    assert format_stake(10000) == "10000"


def test_betslip_item_from_dict():
    item = BetSlipItem.from_dict(
        "x10x10s",
        {
            "event": "NC vs Samsung",
            "selection": "Samsung",
            "odds": 1.88,
            "status": "active",
            "stake": 5000,
        },
    )
    assert item.site == "x10x10s"
    assert item.event == "NC vs Samsung"
    assert item.odds == 1.88
    assert item.stake == 5000
    assert item.status == SlipStatus.ACTIVE


def test_betslip_read_result_first():
    result = BetSlipReadResult(
        site="BC.Game",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="BC.Game", selection="Home", status=SlipStatus.ACTIVE)],
    )
    assert result.first is not None
    assert result.first.selection == "Home"
