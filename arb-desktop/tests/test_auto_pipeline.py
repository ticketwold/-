from __future__ import annotations

import pytest

from arb_desktop.betslip.execution_models import BetSlipLock, LockedSnapshot, LockState
from arb_desktop.betslip.locator_cache import StableLocatorCache
from arb_desktop.betslip.models import BetSlipItem, SlipStatus


def _item(**kwargs) -> BetSlipItem:
    defaults = dict(
        site="BC.Game",
        event="A vs B",
        market="승자",
        selection="A",
        odds=2.0,
        status=SlipStatus.ACTIVE,
        stake=5.0,
    )
    defaults.update(kwargs)
    return BetSlipItem(**defaults)


def test_lock_ok():
    lock = BetSlipLock(
        bc=LockedSnapshot.from_item(_item(site="BC.Game")),
        bti=LockedSnapshot.from_item(_item(site="x10x10s", selection="B")),
    )
    ok, reason = lock.check(_item(), _item(site="x10x10s", selection="B"))
    assert ok is True
    assert lock.state == LockState.OK


def test_lock_broken_on_odds_change():
    lock = BetSlipLock(
        bc=LockedSnapshot.from_item(_item()),
        bti=LockedSnapshot.from_item(_item(site="x10x10s", selection="B")),
    )
    ok, _ = lock.check(_item(odds=2.1), _item(site="x10x10s", selection="B"))
    assert ok is False
    assert lock.state == LockState.BROKEN


def test_lock_ignores_status_change():
    """Lock은 5필드만 — status 변경은 recheck에서만 감지."""
    lock = BetSlipLock(
        bc=LockedSnapshot.from_item(_item()),
        bti=LockedSnapshot.from_item(_item(site="x10x10s", selection="B")),
    )
    ok, _ = lock.check(_item(status=SlipStatus.SUSPENDED), _item(site="x10x10s", selection="B"))
    assert ok is True
    assert lock.state == LockState.OK


def test_recheck_failed_on_status():
    lock = BetSlipLock(
        bc=LockedSnapshot.from_item(_item()),
        bti=LockedSnapshot.from_item(_item(site="x10x10s", selection="B")),
    )
    ok, reason = lock.recheck(_item(status=SlipStatus.SUSPENDED), _item(site="x10x10s", selection="B"))
    assert ok is False
    assert "status" in reason


def test_locator_cache_invalidate_on_hash():
    cache = StableLocatorCache()
    from arb_desktop.betslip.execution_models import LocatorCacheEntry

    cache.put(LocatorCacheEntry(site="BC.Game", frame_url="u", container_selector="c", stake_selector="s", dom_hash="abc"))
    assert cache.should_refresh("BC.Game", "abc") is False
    assert cache.should_refresh("BC.Game", "xyz") is True
