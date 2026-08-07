from __future__ import annotations

import time

from arb_desktop.betslip.models import BetSlipItem, BetSlipReadResult, SlipStatus
from arb_desktop.ui.site_status import SiteStatusDebouncer, site_label, slip_status_from_read, wait_reason_for_site


def test_site_label_korean() -> None:
    assert site_label(SlipStatus.ACTIVE) == "ACTIVE"
    assert site_label(SlipStatus.CLOSED) == "배팅 닫힘"
    assert site_label(SlipStatus.SUSPENDED) == "일시 정지"


def test_slip_status_from_read_empty() -> None:
    read = BetSlipReadResult(site="bc", ok=True, empty=True)
    assert slip_status_from_read(read) == SlipStatus.EMPTY


def test_slip_status_from_read_closed() -> None:
    read = BetSlipReadResult(
        site="bc",
        ok=True,
        empty=False,
        items=[BetSlipItem(site="bc", odds=2.0, status=SlipStatus.CLOSED)],
    )
    assert slip_status_from_read(read) == SlipStatus.CLOSED


def test_wait_reason_for_site() -> None:
    assert wait_reason_for_site("bti", SlipStatus.CLOSED) == "텐텐벳 배팅 닫힘"
    assert wait_reason_for_site("bc", SlipStatus.SUSPENDED) == "BC.Game 일시 정지"
    assert wait_reason_for_site("bc", SlipStatus.ACTIVE) is None


def test_debouncer_requires_two_hits() -> None:
    deb = SiteStatusDebouncer(min_hits=2, min_ms=500)
    first = deb.update("bc", SlipStatus.CLOSED)
    assert first == SlipStatus.EMPTY
    second = deb.update("bc", SlipStatus.CLOSED)
    assert second == SlipStatus.CLOSED


def test_debouncer_confirms_after_200ms() -> None:
    deb = SiteStatusDebouncer(min_hits=5, min_ms=200)
    deb.update("x10", SlipStatus.SUSPENDED)
    time.sleep(0.21)
    confirmed = deb.update("x10", SlipStatus.SUSPENDED)
    assert confirmed == SlipStatus.SUSPENDED
