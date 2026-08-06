import pytest

from arb_desktop.core.json_odds import extract_slip_from_json, url_matches_bc_patterns


def test_extract_slip_nested():
    data = {"data": {"selections": [{"odds": 2.15, "stake": 5, "teamName": "T1"}]}}
    slip = extract_slip_from_json(data)
    assert slip is not None
    assert slip["odds"] == 2.15


def test_url_pattern():
    assert url_matches_bc_patterns("https://api.betby.com/sports/odds", ("betby", "odd"))
    assert not url_matches_bc_patterns("https://google.com", ("betby",))
