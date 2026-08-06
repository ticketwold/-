from __future__ import annotations

import pytest

from arb_desktop.betslip.format import format_betslip_block, format_match_check, format_scan_report
from arb_desktop.betslip.matcher import calculate_arbitrage, check_slip_pair
from arb_desktop.betslip.models import (
    BetSlipItem,
    BetSlipReadResult,
    BetSlipScanResult,
    MatchCheckResult,
    SlipStatus,
)
from arb_desktop.betslip.normalize import (
    event_match_confidence,
    market_match,
    normalize_market_name,
    opposite_selection,
    parse_event_teams,
)
from arb_desktop.betslip.normalize import MarketKind


def _item(site: str, **kwargs) -> BetSlipItem:
    defaults = {
        "site": site,
        "event": "Team A vs Team B",
        "market": "Moneyline",
        "selection": "Team A",
        "odds": 2.0,
        "status": SlipStatus.ACTIVE,
        "source": "dom",
        "frame_url": "https://example.com/frame",
        "container_selector": ".betslip",
    }
    defaults.update(kwargs)
    return BetSlipItem(**defaults)


def _result(site: str, item: BetSlipItem | None) -> BetSlipReadResult:
    if item is None:
        return BetSlipReadResult(site=site, ok=True, empty=True, reason="empty-slip")
    return BetSlipReadResult(site=site, ok=True, empty=False, items=[item])


def test_format_betslip_block_extended():
    item = _item("BC.Game", selection="Team B", odds=1.95, stake=10.5)
    block = format_betslip_block(item)
    assert "market: Moneyline" in block
    assert "source: dom" in block
    assert "frame_url: https://example.com/frame" in block
    assert "container_selector: .betslip" in block
    assert "status: ACTIVE" in block


def test_parse_event_teams():
    home, away = parse_event_teams("NC 다이노스 vs 삼성 라이온스")
    assert home == "NC 다이노스"
    assert away == "삼성 라이온스"


def test_market_match_moneyline():
    ok, reason = market_match("승패", "삼성 라이온스", "Match Winner", "NC 다이노스")
    assert ok is True
    assert reason == MarketKind.MONEYLINE.value


def test_opposite_selection_ml():
    ok, reason = opposite_selection(
        event_a="Team A vs Team B",
        selection_a="Team A",
        market_a="Moneyline",
        event_b="Team A vs Team B",
        selection_b="Team B",
        market_b="Match Winner",
    )
    assert ok is True
    assert reason == "home-vs-away"


def test_event_match_confidence_exact():
    ok, reason = event_match_confidence("Team A vs Team B", "Team A vs Team B")
    assert ok is True
    assert reason == "exact-normalized"


def test_check_slip_pair_opposite_ml():
    bc = _result("BC.Game", _item("BC.Game", selection="Team B", odds=2.1))
    bti = _result("x10x10s", _item("x10x10s", selection="Team A", odds=2.05))
    match = check_slip_pair(bc, bti)
    assert match.same_event is True
    assert match.same_market is True
    assert match.opposite_selection is True
    assert match.safe_to_calculate is True


def test_check_slip_pair_empty():
    match = check_slip_pair(_result("BC.Game", None), _result("x10x10s", _item("x10x10s")))
    assert match.safe_to_calculate is False
    assert "empty" in match.reason


def test_check_slip_pair_suspended():
    bc = _result("BC.Game", _item("BC.Game", status=SlipStatus.SUSPENDED, odds=None))
    bti = _result("x10x10s", _item("x10x10s"))
    match = check_slip_pair(bc, bti)
    assert match.safe_to_calculate is False
    assert "inactive-status" in match.reason


def test_calculate_arbitrage():
    bc = _item("BC.Game", selection="Team B", odds=2.2)
    bti = _item("x10x10s", selection="Team A", odds=2.1)
    arb = calculate_arbitrage(bc, bti, bti_base_stake_krw=10_000, usdt_rate=1400)
    assert arb is not None
    assert arb.arb_possible is True
    assert arb.profit_rate is not None and arb.profit_rate > 0
    assert arb.stake_b == 10_000
    assert arb.stake_a is not None and arb.stake_a > 0


def test_format_scan_report():
    bc = _result("BC.Game", _item("BC.Game", selection="Team B", odds=2.0))
    bti = _result("x10x10s", _item("x10x10s", selection="Team A", odds=2.1))
    match = check_slip_pair(bc, bti)
    arb = calculate_arbitrage(bc.first, bti.first) if bc.first and bti.first else None
    report = format_scan_report(BetSlipScanResult(bc=bc, bti=bti, match=match, arbitrage=arb))
    assert "[BETSLIP]" in report
    assert "[MATCH CHECK]" in report
    assert "[ARBITRAGE]" in report
    assert "same_event: true" in report
