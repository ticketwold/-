from __future__ import annotations

from arb_desktop.market_data.bithumb_fx import FxStatus, _extract_trade_price


def test_extract_trade_price_list_format() -> None:
    payload = [{"market": "KRW-USDT", "trade_price": "1417.30"}]
    assert _extract_trade_price(payload) == 1417.30


def test_extract_trade_price_nested_data() -> None:
    payload = {"data": [{"market": "KRW-USDT", "trade_price": 1400.5}]}
    assert _extract_trade_price(payload) == 1400.5


def test_extract_trade_price_missing() -> None:
    assert _extract_trade_price({"data": [{"market": "KRW-BTC"}]}) is None


def test_fx_snapshot_usable() -> None:
    from arb_desktop.market_data.bithumb_fx import FxSnapshot
    import time

    snap = FxSnapshot(rate=1400.0, status=FxStatus.LIVE, updated_at=time.time(), age_seconds=1.0)
    assert snap.is_usable(30.0) is True

    stale = FxSnapshot(rate=1400.0, status=FxStatus.STALE, updated_at=time.time() - 40, age_seconds=40.0)
    assert stale.is_usable(30.0) is False
