"""BTI API 파싱 테스트."""

from src.sites.pbc00 import Pbc00Adapter


def test_parse_bti_event_moneyline():
  adapter = Pbc00Adapter()
  adapter._current_sport = "football"

  event = {
    "id": "123",
    "eventName": "Team A vs Team B",
    "markets": [{
      "marketType": "ML",
      "selections": [
        {"name": "Home", "price": 1.95},
        {"name": "Away", "price": 2.10},
      ],
    }],
  }

  result = adapter._parse_bti_event(event)
  assert result is not None
  assert result.match.home_team == "Team A"
  assert result.match.away_team == "Team B"
  assert len(result.odds) == 2


def test_parse_bti_participants():
  adapter = Pbc00Adapter()
  adapter._current_sport = "basketball"

  event = {
    "eventId": "456",
    "participants": [
      {"name": "Lakers", "venueRole": "Home"},
      {"name": "Celtics", "venueRole": "Away"},
    ],
    "markets": [{
      "type": "Moneyline",
      "selections": [
        {"designation": "home", "decimalOdds": 1.88},
        {"designation": "away", "decimalOdds": 2.05},
      ],
    }],
  }

  result = adapter._parse_bti_event(event)
  assert result is not None
  assert result.match.home_team == "Lakers"
  assert result.match.away_team == "Celtics"
