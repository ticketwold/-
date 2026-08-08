from __future__ import annotations

from arb_desktop.bridge.connection_manager import (
    ConnectionManager,
    _should_replace_slip,
    _slip_revision,
)
from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus
from arb_desktop.bridge.message_models import SlipUpdateMessage


def _active_read(site: str, odds: float, *, revision: int = 1, dom_hash: str = "a") -> BetSlipReadResult:
    return BetSlipReadResult(
        site=site,
        ok=True,
        empty=False,
        items=[
            BetSlipItem(
                site=site,
                odds=odds,
                status=SlipStatus.ACTIVE,
                dom_hash=dom_hash,
            )
        ],
        raw={"revision": revision, "dom_hash": dom_hash},
    )


def test_revision_forces_replace_even_with_lower_score() -> None:
    current = _active_read("bti", 1.8, revision=101, dom_hash="old")
    newer_empty = BetSlipReadResult(
        site="bti",
        ok=True,
        empty=True,
        reason="empty-slip",
        raw={"revision": 102, "dom_hash": "new"},
    )
    assert _should_replace_slip(current, newer_empty) is True


def test_stale_revision_rejected_in_manager() -> None:
    manager = ConnectionManager(token="secret")
    manager.apply_slip_update(
        SlipUpdateMessage(
            site="x10",
            result={
                "ok": True,
                "empty": False,
                "revision": 102,
                "dom_hash": "hash-b",
                "items": [{"odds": 2.35, "status": "active"}],
            },
        )
    )
    stale = manager.apply_slip_update(
        SlipUpdateMessage(
            site="x10",
            result={
                "ok": True,
                "empty": False,
                "revision": 101,
                "dom_hash": "hash-a",
                "items": [{"odds": 1.8, "status": "active"}],
            },
        )
    )
    assert stale is None
    assert manager.x10_slip and manager.x10_slip.first
    assert manager.x10_slip.first.odds == 2.35
    assert _slip_revision(manager.x10_slip) == 102


def test_dom_hash_change_replaces_active() -> None:
    current = _active_read("bti", 1.8, revision=5, dom_hash="hash-a")
    updated = _active_read("bti", 1.8, revision=5, dom_hash="hash-b")
    assert _should_replace_slip(current, updated) is True
