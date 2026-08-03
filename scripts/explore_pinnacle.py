#!/usr/bin/env python3
"""Pinnacle API 상세 구조 분석."""

import asyncio
import json

import aiohttp


def american_to_decimal(american: float) -> float:
  if american > 0:
    return round(american / 100 + 1, 3)
  return round(100 / abs(american) + 1, 3)


async def main():
  async with aiohttp.ClientSession() as session:
    async with session.get("https://www.pinnacle.com/config/app.json") as resp:
      config = await resp.json()
      api_key = config["api"]["haywire"]["apiKey"]

    headers = {"x-api-key": api_key, "Accept": "application/json"}

    # Get matchups
    async with session.get(
      "https://guest.api.arcadia.pinnacle.com/0.1/sports/29/matchups?withSpecials=false&brandId=0",
      headers=headers,
    ) as resp:
      matchups = await resp.json()

    # Filter regular matchups (not specials)
    regular = [m for m in matchups if m.get("type") == "matchup" and m.get("hasMarkets")]
    print(f"Regular matchups: {len(regular)}")

    sample = regular[0]
    print("\nSample matchup:")
    print(json.dumps(sample, ensure_ascii=False, indent=2)[:1500])

    # Get markets
    async with session.get(
      "https://guest.api.arcadia.pinnacle.com/0.1/sports/29/markets/straight",
      headers=headers,
    ) as resp:
      markets = await resp.json()

    # Build participant map from matchups
    participants = {}
    for m in matchups:
      mid = m["id"]
      for p in m.get("participants", []):
        pid = p.get("id") or p.get("participantId")
        if pid:
          participants[pid] = {
            "name": p.get("name", ""),
            "alignment": p.get("alignment", ""),
            "matchup_id": mid,
          }
      # parent participants for live games
      parent = m.get("parent", {})
      for p in parent.get("participants", []):
        pid = p.get("id") or p.get("participantId")
        if pid:
          participants[pid] = {
            "name": p.get("name", ""),
            "alignment": p.get("alignment", ""),
            "matchup_id": mid,
          }

    # Find moneyline markets for period 0 (full game)
    ml_markets = [
      mk for mk in markets
      if mk.get("type") == "moneyline" and mk.get("period") == 0
    ]
    print(f"\nMoneyline markets (period 0): {len(ml_markets)}")

    for mk in ml_markets[:5]:
      mid = mk["matchupId"]
      matchup = next((m for m in matchups if m["id"] == mid), None)
      if not matchup:
        continue
      home = away = draw = None
      for p in mk["prices"]:
        pinfo = participants.get(p["participantId"], {})
        alignment = pinfo.get("alignment", "")
        decimal = american_to_decimal(p["price"])
        if alignment == "home":
          home = (pinfo["name"], p["price"], decimal)
        elif alignment == "away":
          away = (pinfo["name"], p["price"], decimal)
        elif alignment == "neutral":
          draw = (pinfo.get("name", "Draw"), p["price"], decimal)

      league = matchup.get("league", {}).get("name", "")
      print(f"\n{league}")
      if home:
        print(f"  HOME: {home[0]} @ {home[2]} (american: {home[1]})")
      if draw:
        print(f"  DRAW: {draw[0]} @ {draw[2]} (american: {draw[1]})")
      if away:
        print(f"  AWAY: {away[0]} @ {away[2]} (american: {away[1]})")

    # Total markets
    total_markets = [
      mk for mk in markets
      if mk.get("type") == "total" and mk.get("period") == 0
    ]
    print(f"\nTotal markets (period 0): {len(total_markets)}")
    for mk in total_markets[:3]:
      mid = mk["matchupId"]
      matchup = next((m for m in matchups if m["id"] == mid), None)
      if not matchup:
        continue
      teams = [p["name"] for p in matchup.get("participants", []) if p.get("alignment") in ("home", "away")]
      print(f"\n{' vs '.join(teams)}")
      for p in mk["prices"]:
        pinfo = participants.get(p["participantId"], {})
        designation = p.get("designation", pinfo.get("alignment", ""))
        points = p.get("points", mk.get("points"))
        decimal = american_to_decimal(p["price"])
        print(f"  {designation} {points}: {decimal} (american: {p['price']})")


if __name__ == "__main__":
  asyncio.run(main())
