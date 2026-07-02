from __future__ import annotations

import re
import unicodedata


def normalize_team(name: str) -> str:
  """팀명 정규화 - 사이트 간 매칭용."""
  name = unicodedata.normalize("NFKC", name).lower().strip()

  replacements = [
    (" fc", ""), ("fc ", ""), (" sc", ""), ("sc ", ""),
    (" cf", ""), ("cf ", ""), (" afc", ""), ("afc ", ""),
    (" united", " utd"), (" athletic", " ath"),
    ("ø", "o"), ("ö", "o"), ("ü", "u"), ("é", "e"),
    (" - ", " "), ("  ", " "),
  ]
  for old, new in replacements:
    name = name.replace(old, new)

  name = re.sub(r"[^a-z0-9가-힣\s]", "", name)
  return re.sub(r"\s+", " ", name).strip()


def match_key(home_team: str, away_team: str) -> str:
  """두 팀명으로 고유 매칭 키 생성 (순서 무관)."""
  teams = sorted([normalize_team(home_team), normalize_team(away_team)])
  return f"{teams[0]}|{teams[1]}"


def teams_similar(name_a: str, name_b: str, threshold: float = 0.8) -> bool:
  """팀명 유사도 비교 (간단한 포함 관계 + 정규화 비교)."""
  a, b = normalize_team(name_a), normalize_team(name_b)
  if a == b:
    return True
  if a in b or b in a:
    return True
  # 첫 단어 일치 (e.g. "man utd" vs "manchester united")
  a_words = set(a.split())
  b_words = set(b.split())
  if a_words & b_words:
    overlap = len(a_words & b_words) / max(len(a_words), len(b_words))
    return overlap >= threshold
  return False
