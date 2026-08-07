from __future__ import annotations

from arb_desktop.betslip.bet_type import BetSide, BetType, parse_bet_item, validate_bet_pair


def test_moneyline_pair() -> None:
    x10 = parse_bet_item(market="승패", selection="A팀 승")
    bc = parse_bet_item(market="Moneyline", selection="B팀 승")
    assert x10.bet_type == BetType.MONEYLINE
    pair = validate_bet_pair(x10, bc)
    assert pair.ok
    assert pair.combined_type_label == "머니라인 / 승패"


def test_set_1_moneyline() -> None:
    x10 = parse_bet_item(market="1세트 승패", selection="1세트 A팀 승")
    bc = parse_bet_item(market="1st Set Winner", selection="1세트 B팀 승")
    assert x10.bet_type == BetType.SET_1_MONEYLINE
    assert bc.bet_type == BetType.SET_1_MONEYLINE
    assert validate_bet_pair(x10, bc).ok


def test_map_1_moneyline() -> None:
    x10 = parse_bet_item(market="1번 맵 승패", selection="1번 맵 A팀 승")
    bc = parse_bet_item(market="Map 1 Winner", selection="Map 1 B팀 승")
    assert x10.bet_type == BetType.MAP_1_MONEYLINE
    assert validate_bet_pair(x10, bc).ok


def test_total_over_under() -> None:
    x10 = parse_bet_item(market="언더/오버", selection="오버 36.5")
    bc = parse_bet_item(market="Total", selection="Under 36.5")
    assert x10.bet_type == BetType.TOTAL
    assert x10.side == BetSide.OVER
    assert bc.side == BetSide.UNDER
    pair = validate_bet_pair(x10, bc)
    assert pair.ok
    assert pair.line_label == "36.5"


def test_handicap_opposite() -> None:
    x10 = parse_bet_item(market="핸디캡", selection="A팀 +3.5")
    bc = parse_bet_item(market="Handicap", selection="B팀 -3.5")
    pair = validate_bet_pair(x10, bc)
    assert pair.ok


def test_type_mismatch_over_vs_team_win() -> None:
    x10 = parse_bet_item(market="Total", selection="오버 36.5")
    bc = parse_bet_item(market="승패", selection="B팀 승")
    pair = validate_bet_pair(x10, bc)
    assert not pair.ok
    assert pair.mismatch_kind == "BET_TYPE_MISMATCH"


def test_line_mismatch() -> None:
    x10 = parse_bet_item(market="Total", selection="오버 36.5")
    bc = parse_bet_item(market="Total", selection="Under 37.5")
    pair = validate_bet_pair(x10, bc)
    assert not pair.ok
    assert pair.mismatch_kind == "LINE_MISMATCH"


def test_unknown_blocks() -> None:
    x10 = parse_bet_item(market="", selection="???")
    bc = parse_bet_item(market="승패", selection="B팀 승")
    assert x10.bet_type == BetType.UNKNOWN
    pair = validate_bet_pair(x10, bc)
    assert not pair.ok
