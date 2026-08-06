"""BC.Game betslip text/DOM parsing — Python mirror for unit tests."""

from __future__ import annotations

import re
from dataclasses import dataclass

ODDS_RE = re.compile(r"(?<!\d)(?:1\.\d+|[2-9]\d*(?:\.\d+)?)(?!\d)")
VS_RE = re.compile(
    r"([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{0,60}?)\s+vs\.?\s+([A-Za-z0-9가-힣][A-Za-z0-9가-힣 .'\-()]{0,60})",
    re.I,
)
MARKET_PATTERNS = [
    re.compile(r"(승자\s*\([^)]+\))", re.I),
    re.compile(r"(승자|winner|moneyline|match winner|승패)", re.I),
    re.compile(r"((?:오버|언더|over|under)\s*[+-]?\d+(?:\.\d+)?)", re.I),
    re.compile(r"(핸디캡|handicap|spread)", re.I),
]
SUSPENDED_RE = re.compile(
    r"suspend|suspended|마감|closed|locked|unavailable|정지된|정지됨",
    re.I,
)


@dataclass(slots=True)
class BcParsedSelection:
    event: str
    market: str
    market_normalized: str
    market_kind: str
    selection: str
    odds: float | None
    status: str


def _norm_team_key(name: str) -> str:
    return re.sub(r"[^a-z0-9가-힣]", "", (name or "").lower())


def normalize_team_spacing(name: str) -> str:
    name = re.sub(r"\s+", " ", (name or "").strip())
    name = re.sub(r"([가-힣])([A-Za-z])", r"\1 \2", name)
    name = re.sub(r"([A-Za-z])([가-힣])", r"\1 \2", name)
    return re.sub(r"\s+", " ", name).strip()


def dedupe_repeated_prefix(text: str) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return ""
    words = text.split()
    if len(words) >= 2 and len(words) % 2 == 0:
        half = len(words) // 2
        left = " ".join(words[:half])
        right = " ".join(words[half:])
        if _norm_team_key(left) == _norm_team_key(right):
            return left
    return text


def extract_market(text: str) -> tuple[str, str, str]:
    for pat in MARKET_PATTERNS:
        m = pat.search(text)
        if m:
            raw = m.group(1).strip()
            blob = raw.lower()
            if any(x in blob for x in ("오버", "언더", "over", "under")):
                return raw, "Over/Under", "over_under"
            if any(x in blob for x in ("핸디", "handicap", "spread")):
                return raw, "Handicap", "handicap"
            return raw, "Moneyline", "moneyline"
    return "", "", "unknown"


def parse_odds_value(raw: str, *, exclude: set[float] | None = None) -> float | None:
    exclude = exclude or set()
    m = ODDS_RE.search(str(raw or "").strip())
    if not m:
        return None
    try:
        val = float(m.group(0))
    except ValueError:
        return None
    if val <= 1.01 or val >= 100:
        return None
    if any(abs(val - ex) < 0.001 for ex in exclude):
        return None
    return val


def extract_trailing_odds(text: str, *, exclude: set[float] | None = None) -> tuple[float | None, str]:
    exclude = exclude or set()
    matches = list(ODDS_RE.finditer(text))
    for m in reversed(matches):
        try:
            val = float(m.group(0))
        except ValueError:
            continue
        if val <= 1.01 or val >= 100:
            continue
        if any(abs(val - ex) < 0.001 for ex in exclude):
            continue
        remainder = (text[: m.start()] + text[m.end() :]).strip()
        return val, remainder
    return None, text


def parse_event_teams(text: str) -> tuple[str, str]:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    vs_m = re.search(r"\s+vs\.?\s+", cleaned, re.I)
    if not vs_m:
        return "", ""
    before_vs = dedupe_repeated_prefix(cleaned[: vs_m.start()].strip())
    after_vs = cleaned[vs_m.end() :].strip()
    after_vs = re.sub(r"(승자|winner|moneyline|승패|오버|언더|핸디).*$", "", after_vs, flags=re.I).strip()
    after_vs = re.sub(r"(?<!\d)(?:1\.\d+|[2-9]\d*(?:\.\d+)?)(?!\d)\s*$", "", after_vs).strip()
    return normalize_team_spacing(before_vs), normalize_team_spacing(after_vs)


def infer_selection(event_text: str, market_raw: str, block_text: str) -> str:
    home, away = parse_event_teams(event_text if " vs " in event_text.lower() else block_text)
    if not home:
        home, away = parse_event_teams(block_text)
    if home:
        vs_m = re.search(r"\s+vs\.?\s+", block_text, re.I)
        if vs_m:
            before_vs = dedupe_repeated_prefix(block_text[: vs_m.start()].strip())
            if before_vs:
                return normalize_team_spacing(before_vs)
        return home
    return home or ""


def parse_bc_selection_text(block_text: str, *, stake: float | None = None) -> BcParsedSelection:
    text = re.sub(r"\s+", " ", (block_text or "").strip())
    exclude: set[float] = set()
    if stake and stake > 0:
        exclude.add(float(stake))

    if SUSPENDED_RE.search(text):
        market_raw, market_norm, kind = extract_market(text)
        home, away = parse_event_teams(text)
        event = f"{home} vs {away}" if home and away else dedupe_repeated_prefix(text)
        return BcParsedSelection(
            event=event,
            market=market_raw,
            market_normalized=market_norm,
            market_kind=kind,
            selection=infer_selection(event, market_raw, text),
            odds=None,
            status="suspended",
        )

    odds, without_odds = extract_trailing_odds(text, exclude=exclude)
    market_raw, market_norm, kind = extract_market(without_odds)
    event_part = without_odds
    if market_raw:
        idx = event_part.find(market_raw)
        if idx >= 0:
            event_part = event_part[:idx].strip()

    home, away = parse_event_teams(event_part)
    if home and away:
        event = f"{home} vs {away}"
    else:
        event = dedupe_repeated_prefix(event_part)

    selection = infer_selection(f"{home} vs {away}" if home and away else event, market_raw, without_odds)

    return BcParsedSelection(
        event=event,
        market=market_raw,
        market_normalized=market_norm,
        market_kind=kind,
        selection=selection,
        odds=odds,
        status="active" if odds else "odds_missing",
    )
