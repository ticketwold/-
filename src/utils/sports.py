"""지원 종목 정의 — Pinnacle ID, pbc00 URL, 표시명."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class SportDefinition:
  key: str
  label_ko: str
  label_en: str
  pinnacle_id: int
  pbc00_gamecode: str = ""
  pbc00_game_child_seq: str = ""
  pbc00_event: str = "N"

  def pbc00_page_url(self, base_url: str = "https://pbc00.com") -> str:
    if not self.pbc00_gamecode or not self.pbc00_game_child_seq:
      return ""
    base = base_url.rstrip("/")
    return (
      f"{base}/game/newDetail/0"
      f"?gamecode={self.pbc00_gamecode}"
      f"&game_child_seq={self.pbc00_game_child_seq}"
      f"&event={self.pbc00_event}"
    )


SPORTS: dict[str, SportDefinition] = {
  "football": SportDefinition(
    key="football",
    label_ko="축구",
    label_en="Football",
    pinnacle_id=29,
    pbc00_gamecode="19",
    pbc00_game_child_seq="3659",
  ),
  "baseball": SportDefinition(
    key="baseball",
    label_ko="야구",
    label_en="Baseball",
    pinnacle_id=3,
    # pbc00 종목 URL은 사이트에서 확인 후 settings.yaml sport_pages에 입력
    pbc00_gamecode="",
    pbc00_game_child_seq="",
  ),
  "basketball": SportDefinition(
    key="basketball",
    label_ko="농구",
    label_en="Basketball",
    pinnacle_id=4,
    pbc00_gamecode="",
    pbc00_game_child_seq="",
  ),
  "esports": SportDefinition(
    key="esports",
    label_ko="e스포츠",
    label_en="Esports",
    pinnacle_id=12,
    pbc00_gamecode="",
    pbc00_game_child_seq="",
  ),
  "tennis": SportDefinition(
    key="tennis",
    label_ko="테니스",
    label_en="Tennis",
    pinnacle_id=33,
    pbc00_gamecode="",
    pbc00_game_child_seq="",
  ),
}

SUPPORTED_SPORT_KEYS = list(SPORTS.keys())

PINNACLE_SPORT_IDS: dict[str, int] = {
  s.key: s.pinnacle_id for s in SPORTS.values()
}
PINNACLE_SPORT_IDS["soccer"] = 29

PINNACLE_ID_TO_KEY: dict[int, str] = {
  s.pinnacle_id: s.key for s in SPORTS.values()
}


def normalize_sport_key(name: str, sport_id: Optional[int] = None) -> str:
  """사이트별 종목명 → 내부 키."""
  if sport_id is not None and sport_id in PINNACLE_ID_TO_KEY:
    return PINNACLE_ID_TO_KEY[sport_id]

  key = name.strip().lower()
  aliases = {
    "soccer": "football",
    "football": "football",
    "baseball": "baseball",
    "basketball": "basketball",
    "esports": "esports",
    "e-sports": "esports",
    "e sports": "esports",
    "tennis": "tennis",
  }
  return aliases.get(key, key)


def get_sport(key: str) -> Optional[SportDefinition]:
  return SPORTS.get(normalize_sport_key(key))


def default_sport_pages(base_url: str = "https://pbc00.com") -> dict[str, dict]:
  """설정 파일용 기본 sport_pages 딕셔너리."""
  pages: dict[str, dict] = {}
  for sport in SPORTS.values():
    url = sport.pbc00_page_url(base_url)
    pages[sport.key] = {
      "enabled": bool(url),
      "gamecode": sport.pbc00_gamecode,
      "game_child_seq": sport.pbc00_game_child_seq,
      "event": sport.pbc00_event,
      "page_url": url,
    }
  return pages
