"""sptpub /api/v4/live · /api/v4/prematch 파서 테스트."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from arb_desktop.core.sptpub_v4_parser import (
    SptpubV4Parser,
    collect_display_odds_from_events,
    match_display_odds,
    parse_decimal_odds,
    parse_sptpub_v4_matchups,
    parse_sptpub_v4_payload,
)
from arb_desktop.scanners.network.sptpub_v4 import SptpubV4Client

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str):
    return json.loads((FIXTURES / name).read_text())


class TestParseDecimalOdds:
    def test_valid_range(self):
        assert parse_decimal_odds(2.15) == 2.15
        assert parse_decimal_odds("1.72") == 1.72

    def test_rejects_status_values(self):
        assert parse_decimal_odds(1, "status") is None
        assert parse_decimal_odds(0, "status") is None
        assert parse_decimal_odds(2, "match_status") is None

    def test_rejects_out_of_range(self):
        assert parse_decimal_odds(1.0) is None
        assert parse_decimal_odds(100.5) is None
        assert parse_decimal_odds(500, "score") is None


class TestSptpubLiveV4:
  @pytest.fixture
  def live_data(self):
      return _load("sptpub_live_v4.json")

  def test_finds_odds_not_status(self, live_data):
      events = parse_sptpub_v4_payload(live_data, feed="live")
      assert len(events) >= 2
      t1_event = next(e for e in events if e.home == "T1")
      odds = {oc.team: oc.decimal for oc in t1_event.outcomes}
      assert odds["T1"] == pytest.approx(2.15, abs=0.01)
      assert odds["Gen.G"] == pytest.approx(1.72, abs=0.01)

  def test_multiple_odds_keys(self, live_data):
      events = parse_sptpub_v4_payload(live_data, feed="live")
      drx = next(e for e in events if e.home == "DRX")
      prices = sorted(oc.decimal for oc in drx.outcomes)
      assert prices == pytest.approx([1.88, 1.95], abs=0.01)

  def test_display_match_live(self, live_data):
      events = parse_sptpub_v4_payload(live_data, feed="live")
      parsed = collect_display_odds_from_events(events)
      # 화면에 표시되는 배당 (사용자가 보는 값)
      display = {
          "t1|gen.g": [2.15, 1.72],
          "drx|kt rolster": [1.95, 1.88],
      }
      matched, total, errors = match_display_odds(parsed, display)
      assert matched == total == 4
      assert not errors


class TestSptpubPrematchV4:
  @pytest.fixture
  def prematch_data(self):
      return _load("sptpub_prematch_v4.json")

  def test_prematch_nested_markets(self, prematch_data):
      events = parse_sptpub_v4_payload(prematch_data, feed="prematch")
      hle = next(e for e in events if "Hanwha" in e.home)
      odds = {oc.team: oc.decimal for oc in hle.outcomes}
      assert odds["Hanwha Life Esports"] == pytest.approx(1.62, abs=0.01)
      assert odds["Dplus KIA"] == pytest.approx(2.35, abs=0.01)

  def test_prematch_selections_dict(self, prematch_data):
      events = parse_sptpub_v4_payload(prematch_data, feed="prematch")
      ns = next(e for e in events if "Nongshim" in e.home)
      odds = sorted(oc.decimal for oc in ns.outcomes)
      assert odds == pytest.approx([1.55, 2.48], abs=0.01)

  def test_display_match_prematch(self, prematch_data):
      events = parse_sptpub_v4_payload(prematch_data, feed="prematch")
      parsed = collect_display_odds_from_events(events)
      display = {
          "hanwha life esports|dplus kia": [1.62, 2.35],
          "nongshim redforce|fearx": [1.55, 2.48],
      }
      matched, total, errors = match_display_odds(parsed, display)
      assert matched == total == 4
      assert not errors

  def test_top_level_status_ignored(self, prematch_data):
      """최상위 status=0 이 배당으로 파싱되지 않아야 함."""
      events = parse_sptpub_v4_payload(prematch_data, feed="prematch")
      all_odds = [oc.decimal for e in events for oc in e.outcomes]
      assert 0 not in all_odds
      assert 1 not in all_odds


class TestSptpubCdpIntegration:
  def test_parse_cdp_live_url(self):
      raw = (FIXTURES / "sptpub_live_v4.json").read_bytes()
      url = "https://abc.sptpub.com/api/v4/live?lang=en"
      matchups = SptpubV4Client.parse_cdp_payload(raw, url)
      assert len(matchups) >= 2
      assert any(m.home == "T1" for m in matchups)

  def test_parse_cdp_prematch_url(self):
      raw = (FIXTURES / "sptpub_prematch_v4.json").read_bytes()
      url = "https://abc.sptpub.com/api/v4/prematch"
      matchups = SptpubV4Client.parse_cdp_payload(raw, url)
      assert len(matchups) >= 2

  def test_to_matchups(self):
      data = _load("sptpub_live_v4.json")
      matchups = parse_sptpub_v4_matchups(data, feed="live")
      assert all(len(m.moneyline) >= 2 for m in matchups)
