"""sptpub payload 선택 로직 테스트."""

import json
from pathlib import Path

import pytest

from arb_desktop.validation.sptpub_payload import (
    analyze_payload,
    is_init_status_url,
    select_best_payload,
    select_with_fallback,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_init_url_detection():
    assert is_init_status_url("https://x.sptpub.com/api/v4/live/foo/ko/3")
    assert is_init_status_url("https://x.sptpub.com/api/v4/live/ko/0")
    assert not is_init_status_url("https://x.sptpub.com/api/v4/live")


def test_reject_ko_init_empty():
    raw = json.dumps({"version": 1, "status": 0}).encode()
    url = "https://abc.sptpub.com/api/v4/live/sport/ko/3"
    c = analyze_payload(url, raw)
    assert c is not None
    assert c.is_init_url
    assert c.event_count == 0
    assert not c.adoptable


def test_pick_live_with_events_over_ko_init():
    init_raw = json.dumps({"version": 99, "status": 0}).encode()
    live_raw = (FIXTURES / "sptpub_live_v4.json").read_bytes()
    init = analyze_payload("https://x.sptpub.com/api/v4/live/ko/3", init_raw)
    live = analyze_payload("https://x.sptpub.com/api/v4/live", live_raw)
    assert init and live
    best = select_best_payload([init, live], prefer_feed="live")
    assert best is not None
    assert best.parsed_event_count >= 2
    assert "/ko/" not in best.url


def test_prematch_fallback():
    live_raw = json.dumps({"version": 5, "events": {}}).encode()
    pm_raw = (FIXTURES / "sptpub_prematch_v4.json").read_bytes()
    live = analyze_payload("https://x.sptpub.com/api/v4/live", live_raw)
    pm = analyze_payload("https://x.sptpub.com/api/v4/prematch", pm_raw)
    selected, label = select_with_fallback([live, pm])
    assert selected is not None
    assert "prematch" in label or selected.feed == "prematch"
    assert selected.parsed_event_count >= 1
