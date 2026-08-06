from __future__ import annotations

import re
from dataclasses import dataclass, field
from time import time
from typing import Any

import orjson

from arb_desktop.core.sptpub_v4_parser import parse_sptpub_v4_payload, sptpub_feed_from_url

# /api/v4/live/.../ko/0 · /ko/3 등 초기화/상태 응답
INIT_URL_RE = re.compile(r"/ko/\d+/?(\?|$)", re.I)
SPTPUB_FEED_RE = re.compile(r"/api/v4/(live|prematch)", re.I)


@dataclass(slots=True)
class PayloadCandidate:
    url: str
    feed: str
    raw: bytes
    data: dict[str, Any]
    top_keys: list[str]
    event_count: int
    parsed_event_count: int
    market_count: int
    selection_count: int
    version: float
    generated: str
    is_init_url: bool
    captured_at: float = field(default_factory=time)
    rejected_reason: str = ""

    @property
    def score(self) -> float:
        if self.is_init_url:
            return -1.0
        if self.event_count < 1 and self.parsed_event_count < 1:
            return -1.0
        s = max(self.event_count, self.parsed_event_count) * 10_000.0
        if self.market_count > 0:
            s += 500.0
        if self.selection_count > 0:
            s += 200.0
        s += self.version
        s += self.captured_at / 1_000_000_000.0  # 최신 응답 우선
        return s

    @property
    def adoptable(self) -> bool:
        return self.score > 0 and not self.rejected_reason


def is_sptpub_feed_url(url: str) -> bool:
    u = (url or "").lower()
    return "sptpub" in u and bool(SPTPUB_FEED_RE.search(u))


def is_init_status_url(url: str) -> bool:
    """초기화/상태 전용 URL (/ko/0, /ko/3 등)."""
    return bool(INIT_URL_RE.search(url or ""))


def _top_level_keys(data: Any) -> list[str]:
    if isinstance(data, dict):
        return list(data.keys())[:30]
    if isinstance(data, list):
        return [f"[list:{len(data)}]"]
    return []


def _count_container(data: dict[str, Any], key: str) -> int:
    val = data.get(key)
    if isinstance(val, dict):
        return len(val)
    if isinstance(val, list):
        return len(val)
    return 0


def _extract_version(data: dict[str, Any]) -> float:
    for k in ("version", "last", "seq", "revision", "timestamp", "ts"):
        v = data.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
        if isinstance(v, str) and v.isdigit():
            return float(v)
    for k in ("generatedAt", "generated_at", "updatedAt", "updated_at"):
        v = data.get(k)
        if v is not None:
            return hash(str(v)) % 1_000_000  # 정렬용 pseudo-version
    return 0.0


def _extract_generated(data: dict[str, Any]) -> str:
    for k in ("generatedAt", "generated_at", "updatedAt", "updated_at", "last_update"):
        v = data.get(k)
        if v is not None:
            return str(v)[:40]
    return ""


def analyze_payload(url: str, raw: bytes | str) -> PayloadCandidate | None:
    try:
        data = orjson.loads(raw) if isinstance(raw, (bytes, str)) else raw
    except orjson.JSONDecodeError:
        return None

    if not isinstance(data, dict):
        return PayloadCandidate(
            url=url,
            feed=sptpub_feed_from_url(url),
            raw=raw if isinstance(raw, bytes) else str(raw).encode(),
            data={},
            top_keys=_top_level_keys(data),
            event_count=0,
            parsed_event_count=0,
            market_count=0,
            selection_count=0,
            version=0,
            generated="",
            is_init_url=is_init_status_url(url),
            rejected_reason="not a JSON object",
        )

    feed = sptpub_feed_from_url(url)
    if feed == "unknown":
        m = SPTPUB_FEED_RE.search(url)
        feed = m.group(1).lower() if m else "unknown"

    event_count = max(_count_container(data, "events"), _count_container(data, "event"))
    market_count = _count_container(data, "markets") + _count_container(data, "market")
    selection_count = (
        _count_container(data, "selections")
        + _count_container(data, "outcomes")
        + _count_container(data, "outcome")
    )

    parsed = parse_sptpub_v4_payload(data, feed=feed)
    parsed_event_count = len(parsed)

    init = is_init_status_url(url)
    rejected = ""
    if init and event_count < 1 and parsed_event_count < 1:
        rejected = "init/status URL (/ko/N) with no events"

    raw_bytes = raw if isinstance(raw, bytes) else str(raw).encode()

    return PayloadCandidate(
        url=url,
        feed=feed,
        raw=raw_bytes,
        data=data,
        top_keys=_top_level_keys(data),
        event_count=event_count,
        parsed_event_count=parsed_event_count,
        market_count=market_count,
        selection_count=selection_count,
        version=_extract_version(data),
        generated=_extract_generated(data),
        is_init_url=init,
        rejected_reason=rejected,
    )


def select_best_payload(
    candidates: list[PayloadCandidate],
    *,
    prefer_feed: str = "live",
) -> PayloadCandidate | None:
    """events≥1, version 최신, markets/selections 존재 우선."""
    adoptable = [c for c in candidates if c.adoptable]
    if not adoptable:
        return None

    feed_pref = [c for c in adoptable if c.feed == prefer_feed]
    pool = feed_pref if feed_pref else adoptable
    pool.sort(key=lambda c: c.score, reverse=True)
    return pool[0]


def select_with_fallback(
    candidates: list[PayloadCandidate],
) -> tuple[PayloadCandidate | None, str]:
    live = select_best_payload(candidates, prefer_feed="live")
    if live and live.parsed_event_count >= 1:
        return live, "live"
    prematch = select_best_payload(candidates, prefer_feed="prematch")
    if prematch and prematch.parsed_event_count >= 1:
        return prematch, "prematch (live fallback)"
    # parsed 0이어도 raw event count 있는 것
    live2 = select_best_payload(candidates, prefer_feed="live")
    if live2:
        return live2, "live (raw events only)"
    prematch2 = select_best_payload(candidates, prefer_feed="prematch")
    if prematch2:
        return prematch2, "prematch"
    return None, "none"
