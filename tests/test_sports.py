"""종목 유틸 및 매칭 테스트."""

from src.utils.match_matcher import match_key
from src.utils.sports import SPORTS, normalize_sport_key


def test_supported_sports():
  assert set(SPORTS.keys()) == {
    "football", "baseball", "basketball", "esports", "tennis",
  }


def test_normalize_sport_key():
  assert normalize_sport_key("Soccer") == "football"
  assert normalize_sport_key("e-Sports") == "esports"
  assert normalize_sport_key("", sport_id=33) == "tennis"


def test_match_key_includes_sport():
  key_fb = match_key("Team A", "Team B", "football")
  key_bb = match_key("Team A", "Team B", "basketball")
  assert key_fb != key_bb
