from __future__ import annotations

from arb_desktop.core.sptpub_v4_parser import ParsedEvent, parse_sptpub_v4_payload
from arb_desktop.scanners.network.sptpub_v4 import SptpubV4Client
from arb_desktop.validation.models import TeamOdds, VerifyEvent

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


def parsed_event_to_verify(ev: ParsedEvent, *, ml_only: bool = True) -> VerifyEvent:
    odds: list[TeamOdds] = []
    for oc in ev.outcomes:
        if ml_only and oc.market and not is_ml_market(oc.market):
            continue
        odds.append(
            TeamOdds(team=oc.team, decimal=oc.decimal, market=oc.market, source="api")
        )
    return VerifyEvent(
        event_id=ev.event_id,
        home=ev.home,
        away=ev.away,
        title=f"{ev.home} vs {ev.away}",
        league=ev.league,
        odds=odds,
        feed=ev.feed or "live",
    )


async def fetch_live_api_events(
    sptpub: SptpubV4Client,
    *,
    ml_only: bool = True,
) -> tuple[list[VerifyEvent], str, dict | None]:
    """sptpub /api/v4/live → VerifyEvent 리스트."""
    if not sptpub._base_url:
        return [], "sptpub base URL 없음", None

    url = f"{sptpub._base_url}/api/v4/live"
    client = await sptpub._ensure_client()
    try:
        resp = await client.get(url)
        if resp.status_code != 200:
            return [], f"live API HTTP {resp.status_code}", None
        import orjson

        raw = orjson.loads(resp.content)
        events = parse_sptpub_v4_payload(raw, feed="live")
        verify = [parsed_event_to_verify(e, ml_only=ml_only) for e in events]
        verify = [v for v in verify if v.odds]
        return verify, f"live API {len(verify)} events @ {url}", raw
    except Exception as exc:
        return [], f"live API error: {exc}", None


def events_from_cdp_payload(raw: bytes | str, url: str, *, ml_only: bool = True) -> list[VerifyEvent]:
    events = parse_sptpub_v4_payload(
        __import__("orjson").loads(raw) if isinstance(raw, (bytes, str)) else raw,
        feed="live",
    )
    if "/prematch" in (url or "").lower():
        return []
    return [parsed_event_to_verify(e, ml_only=ml_only) for e in events if e.outcomes]
