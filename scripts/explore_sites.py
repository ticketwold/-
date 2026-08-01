#!/usr/bin/env python3
"""사이트 구조 탐색 스크립트."""

import asyncio
import json
import re

import aiohttp


async def explore_pinnacle_api():
  print("=== Pinnacle API ===")
  async with aiohttp.ClientSession() as session:
    async with session.get("https://www.pinnacle.com/config/app.json") as resp:
      config = await resp.json()
      api_key = config["api"]["haywire"]["apiKey"]
      print(f"API Key: {api_key[:20]}...")

    headers = {"x-api-key": api_key}

    # Football sport id = 29
    for sport_id, sport_name in [(29, "football"), (4, "basketball")]:
      url = f"https://guest.api.arcadia.pinnacle.com/0.1/sports/{sport_id}/matchups?withSpecials=false&brandId=0"
      async with session.get(url, headers=headers) as resp:
        data = await resp.json()
        print(f"\n{sport_name}: {len(data)} matchups")
        for m in data[:3]:
          print(json.dumps(m, ensure_ascii=False, indent=2)[:800])
          print("---")

    # Get markets for football
    url = "https://guest.api.arcadia.pinnacle.com/0.1/sports/29/markets/straight"
    async with session.get(url, headers=headers) as resp:
      markets = await resp.json()
      print(f"\nFootball markets: {len(markets)}")
      for m in markets[:2]:
        print(json.dumps(m, ensure_ascii=False, indent=2)[:600])


async def explore_pbc00():
  print("\n=== PBC00 Playwright ===")
  from playwright.async_api import async_playwright

  api_requests = []

  async with async_playwright() as p:
    browser = await p.chromium.launch(headless=True)
    context = await browser.new_context(
      user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    )
    page = await context.new_page()

    async def on_response(response):
      url = response.url
      if any(k in url for k in ["api", "odds", "game", "match", "event", "bet", "sport"]):
        try:
          ct = response.headers.get("content-type", "")
          if "json" in ct:
            body = await response.json()
            api_requests.append({"url": url, "body": body})
        except Exception:
          pass

    page.on("response", on_response)

    try:
      await page.goto(
        "https://pbc00.com/game/newDetail/0?gamecode=19&game_child_seq=3659&event=N",
        wait_until="networkidle",
        timeout=60000,
      )
    except Exception as e:
      print(f"Navigation warning: {e}")

    await page.wait_for_timeout(5000)

    title = await page.title()
    print(f"Title: {title}")

    # Save screenshot
    await page.screenshot(path="/workspace/scripts/pbc00_screenshot.png")

    # Get page text sample
    text = await page.inner_text("body")
    print(f"Body text (first 2000 chars):\n{text[:2000]}")

    # Look for odds-like patterns
    odds_patterns = re.findall(r"\d+\.\d{2}", text)
    print(f"\nOdds-like numbers: {odds_patterns[:20]}")

    # API requests captured
    print(f"\nCaptured {len(api_requests)} API requests:")
    for req in api_requests[:10]:
      print(f"\nURL: {req['url']}")
      body_str = json.dumps(req["body"], ensure_ascii=False)
      print(body_str[:500])

    # Try to find key elements
    selectors = [
      "[class*='odds']", "[class*='Odds']", "[class*='bet']",
      "[class*='match']", "[class*='game']", "[class*='team']",
      "table", ".price", "[data-odds]",
    ]
    for sel in selectors:
      count = await page.locator(sel).count()
      if count > 0:
        print(f"Selector '{sel}': {count} elements")
        sample = await page.locator(sel).first.inner_text()
        print(f"  Sample: {sample[:100]}")

    await browser.close()


async def main():
  await explore_pinnacle_api()
  await explore_pbc00()


if __name__ == "__main__":
  asyncio.run(main())
