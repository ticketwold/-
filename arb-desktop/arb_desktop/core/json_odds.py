from __future__ import annotations

from typing import Any

import orjson


def _parse_odds(val: Any) -> float | None:
    try:
        n = float(val)
        if 1.01 < n < 100:
            return n
    except (TypeError, ValueError):
        pass
    return None


def _parse_amount(val: Any) -> float | None:
    try:
        n = float(str(val or "").replace(",", ""))
        if n > 0:
            return n
    except (TypeError, ValueError):
        pass
    return None


def extract_slip_from_json(data: Any, depth: int = 0) -> dict[str, Any] | None:
    """Port of extension-legacy/bc_api_hook.js recursive JSON odds extractor."""
    if data is None or depth > 16:
        return None

    if isinstance(data, (bytes, bytearray)):
        try:
            data = orjson.loads(data)
        except orjson.JSONDecodeError:
            return None

    if isinstance(data, str):
        if len(data) < 4 or len(data) > 500_000:
            return None
        try:
            return extract_slip_from_json(orjson.loads(data), depth + 1)
        except orjson.JSONDecodeError:
            return None

    if isinstance(data, list):
        for item in data:
            found = extract_slip_from_json(item, depth + 1)
            if found:
                return found
        return None

    if not isinstance(data, dict):
        return None

    odds = _parse_odds(
        data.get("odds")
        or data.get("price")
        or data.get("coefficient")
        or data.get("decimalOdds")
        or data.get("oddsValue")
        or data.get("odd")
    )
    stake = _parse_amount(
        data.get("stake")
        or data.get("amount")
        or data.get("betAmount")
        or data.get("bet_stake")
        or data.get("betAmountUsd")
    )
    payout = _parse_amount(
        data.get("payout")
        or data.get("potentialWin")
        or data.get("toWin")
        or data.get("winAmount")
        or data.get("possibleWin")
    )

    if odds and (stake or payout):
        implied = round(payout / stake, 3) if stake and payout and payout > stake else odds
        return {
            "odds": implied,
            "stake": stake,
            "payout": payout,
            "team": data.get("teamName") or data.get("outcomeName") or data.get("selectionName") or "",
        }

    for key in ("bets", "selections", "betSlip", "betslip", "items", "data", "result", "payload"):
        if key in data:
            found = extract_slip_from_json(data[key], depth + 1)
            if found:
                return found

    for key, val in data.items():
        if key.lower() in {"code", "msg", "message", "status", "success", "timestamp", "id"}:
            continue
        found = extract_slip_from_json(val, depth + 1)
        if found:
            return found

    return None


def url_matches_bc_patterns(url: str, patterns: tuple[str, ...]) -> bool:
    u = (url or "").lower()
    return any(p.lower() in u for p in patterns)
