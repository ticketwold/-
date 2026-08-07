from __future__ import annotations

import time

from arb_desktop.betslip.x10_slip_status import X10StatusState, classify_x10_status


def test_case_a_button_disabled_with_odds() -> None:
    result = classify_x10_status(
        block_text="1.85",
        extracted_odds=1.85,
        bet_button_disabled=True,
    )
    assert result.status == "closed"
    assert result.reason == "bet-button-disabled"
    assert result.previous_odds == 1.85


def test_case_b_odds_disappear_after_active() -> None:
    state = X10StatusState(last_active_odds=1.85, last_status="active")
    now = time.monotonic()
    pending = classify_x10_status(extracted_odds=None, state=state, now=now)
    assert pending.status == "closed_pending"
    assert pending.reason == "odds-missing"
    assert pending.previous_odds == 1.85

    closed = classify_x10_status(extracted_odds=None, state=state, now=now + 0.25)
    assert closed.status == "closed"
    assert closed.reason == "betting-closed"
    assert closed.previous_odds == 1.85


def test_case_c_closed_keyword_text() -> None:
    result = classify_x10_status(block_text="배팅 마감", extracted_odds=1.85)
    assert result.status == "closed"
    assert result.diagnostics.matched_keyword


def test_case_d_suspended_class() -> None:
    result = classify_x10_status(
        block_text="",
        extracted_odds=1.85,
        slip_root_class="bet-slip-item suspended",
    )
    assert result.status == "suspended"
    assert result.reason == "suspended-class"


def test_case_e_aria_disabled() -> None:
    result = classify_x10_status(
        block_text="",
        extracted_odds=1.85,
        aria_disabled=True,
    )
    assert result.status == "disabled"
    assert result.reason == "aria-disabled"


def test_case_f_recovery_to_active() -> None:
    state = X10StatusState(last_active_odds=1.85, last_status="closed")
    result = classify_x10_status(extracted_odds=1.90, state=state)
    assert result.status == "active"
    assert result.reason == "active"
    assert state.last_active_odds == 1.90
