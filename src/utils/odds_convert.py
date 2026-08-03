from __future__ import annotations


def american_to_decimal(american: float) -> float:
  """미국식 배당을 유럽식(소수) 배당으로 변환."""
  if american > 0:
    return round(american / 100 + 1, 3)
  return round(100 / abs(american) + 1, 3)
