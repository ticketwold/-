from __future__ import annotations

import orjson

from arb_desktop.core.sptpub_v4_parser import parse_sptpub_v4_payload
from arb_desktop.scanners.network.sptpub_v4 import SptpubV4Client
from arb_desktop.validation.models import TeamOdds, VerifyEvent
from arb_desktop.validation.sptpub_payload import PayloadCandidate

# Moneyline / Winner 마켓만 비교
ML_MARKET_PATTERN = (
    "winner",
    "moneyline",
    "money line",
    "1x2",
    "match winner",
    "matchwinner",
    "to win",
    "승",
    "승패",
    "ml",
    "w1",
    "w2",
)


def is_ml_market(market: str) -> bool:
    if not market:
        return True
    m = market.lower()
    return any(p in m for p in ML_MARKET_PATTERN)


def parsed_events_to_verify(parsed, *, ml_only: bool = True) -> list[VerifyEvent]:
    from arb_desktop.core.sptpub_v4_parser import ParsedEvent

    out: list[VerifyEvent] = []
    for ev in parsed:
        odds: list[TeamOdds] = []
        for oc in ev.outcomes:
            if ml_only and oc.market and not is_ml_market(oc.market):
                continue
            odds.append(TeamOdds(team=oc.team, decimal=oc.decimal, market=oc.market, source="api"))
        if not odds:
            continue
        out.append(
            VerifyEvent(
                event_id=ev.event_id,
                home=ev.home,
                away=ev.away,
                title=f"{ev.home} vs {ev.away}",
                league=ev.league,
                odds=odds,
                feed=ev.feed or "live",
            )
        )
    return out


def events_from_payload_candidate(candidate: PayloadCandidate, *, ml_only: bool = True) -> list[VerifyEvent]:
    parsed = parse_sptpub_v4_payload(candidate.data, feed=candidate.feed)
    return parsed_events_to_verify(parsed, ml_only=ml_only)


def events_from_cdp_payload(raw: bytes | str, url: str, *, ml_only: bool = True) -> list[VerifyEvent]:
    from arb_desktop.validation.sptpub_payload import analyze_payload, sptpub_feed_from_url

    cand = analyze_payload(url, raw)
    if not cand:
        return []
    return events_from_payload_candidate(cand, ml_only=ml_only)


async def fetch_feed_api_events(
    sptpub: SptpubV4Client,
    *,
    feed: str = "live",
    ml_only: bool = True,
) -> tuple[list[VerifyEvent], str, dict | None]:
    if not sptpub._base_url:
        return [], f"{feed} API: sptpub base URL 없음", None

    url = f"{sptpub._base_url}/api/v4/{feed}"
    client = await sptpub._ensure_client()
    try:
        resp = await client.get(url)
        if resp.status_code != 200:
            return [], f"{feed} API HTTP {resp.status_code}", None
        raw = orjson.loads(resp.content)
        parsed = parse_sptpub_v4_payload(raw, feed=feed)
        verify = parsed_events_to_verify(parsed, ml_only=ml_only)
        return verify, f"{feed} API {len(verify)} events @ {url}", raw
    except Exception as exc:
        return [], f"{feed} API error: {exc}", None


async def fetch_live_api_events(
    sptpub: SptpubV4Client,
    *,
    ml_only: bool = True,
) -> tuple[list[VerifyEvent], str, dict | None]:
    return await fetch_feed_api_events(sptpub, feed="live", ml_only=ml_only)
