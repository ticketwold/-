"""x10 BetSlip status classification — mirrors chrome-bridge/frame_scanner.js rules."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

CLOSED_PENDING_MS = 200

CLOSED_KEYWORD_RE = re.compile(
    r"betting\s*closed|market\s*closed|odds\s*unavailable|"
    r"배팅\s*닫|베팅\s*닫|닫힘|배팅불가|베팅불가|"
    r"\bclosed\b|\blocked\b|\binactive\b|\bunavailable\b|마감",
    re.IGNORECASE,
)
SUSPENDED_KEYWORD_RE = re.compile(
    r"\bsuspended\b|일시\s*정지|일시정지|\bpaused\b",
    re.IGNORECASE,
)
DISABLED_KEYWORD_RE = re.compile(
    r"\bdisabled\b|배팅\s*불가|베팅\s*불가|정지(?!된)",
    re.IGNORECASE,
)
STATUS_CLASS_RE = re.compile(
    r"\b(disabled|suspended|closed|locked|inactive|unavailable)\b",
    re.IGNORECASE,
)


@dataclass
class X10StatusDiagnostics:
    raw_status_text: str = ""
    odds_element_present: bool = False
    odds_element_disabled: bool = False
    slip_root_class: str = ""
    bet_button_disabled: bool = False
    aria_disabled: bool = False
    matched_keyword: str = ""
    parsed_status: str = "active"
    reason: str = ""


@dataclass
class X10StatusState:
    last_active_odds: float | None = None
    last_status: str = "empty"
    odds_missing_since: float | None = None


@dataclass
class X10StatusResult:
    status: str
    reason: str
    previous_odds: float | None
    diagnostics: X10StatusDiagnostics = field(default_factory=X10StatusDiagnostics)


def _match_keyword(block_text: str) -> tuple[str, str, str]:
    for pattern, status, label in (
        (CLOSED_KEYWORD_RE, "closed", "closed-keyword"),
        (SUSPENDED_KEYWORD_RE, "suspended", "suspended-keyword"),
        (DISABLED_KEYWORD_RE, "disabled", "disabled-keyword"),
    ):
        m = pattern.search(block_text or "")
        if m:
            return status, label, m.group(0)
    return "", "", ""


def classify_x10_status(
    *,
    block_text: str = "",
    extracted_odds: float | None = None,
    bet_button_disabled: bool = False,
    container_disabled: bool = False,
    odds_element_disabled: bool = False,
    aria_disabled: bool = False,
    slip_root_class: str = "",
    state: X10StatusState | None = None,
    now: float | None = None,
) -> X10StatusResult:
    """Classify x10 slip status from DOM probe data (priority: CLOSED > SUSPENDED > DISABLED > ACTIVE)."""
    state = state or X10StatusState()
    now = time.monotonic() if now is None else now
    diag = X10StatusDiagnostics(
        raw_status_text=(block_text or "")[:240],
        odds_element_present=extracted_odds is not None,
        odds_element_disabled=odds_element_disabled,
        slip_root_class=slip_root_class,
        bet_button_disabled=bet_button_disabled,
        aria_disabled=aria_disabled,
    )

    kw_status, kw_reason, kw_match = _match_keyword(block_text)
    if kw_match:
        diag.matched_keyword = kw_match

    class_hit = STATUS_CLASS_RE.search(slip_root_class or "")
    if class_hit and not kw_match:
        token = class_hit.group(1).lower()
        if token == "suspended":
            kw_status, kw_reason, kw_match = "suspended", "suspended-class", token
        else:
            kw_status, kw_reason, kw_match = "closed", "closed-class", token
        diag.matched_keyword = kw_match

    if bet_button_disabled:
        return _finalize("closed", "bet-button-disabled", extracted_odds, state, diag, now)
    if aria_disabled or container_disabled:
        status = "disabled" if aria_disabled and not container_disabled else "closed"
        reason = "aria-disabled" if aria_disabled else "disabled-container"
        return _finalize(status, reason, extracted_odds, state, diag, now)
    if odds_element_disabled:
        return _finalize("closed", "odds-element-disabled", extracted_odds, state, diag, now)
    if kw_status == "closed":
        return _finalize("closed", kw_reason, extracted_odds, state, diag, now)
    if kw_status == "suspended":
        return _finalize("suspended", kw_reason, extracted_odds, state, diag, now)
    if kw_status == "disabled":
        return _finalize("disabled", kw_reason, extracted_odds, state, diag, now)

    if extracted_odds is None:
        prev = state.last_active_odds
        was_active = prev is not None and state.last_status in {"active", "closed_pending"}
        if was_active:
            if state.odds_missing_since is None:
                state.odds_missing_since = now
                return _finalize("closed_pending", "odds-missing", prev, state, diag, now)
            if (now - state.odds_missing_since) * 1000 < CLOSED_PENDING_MS:
                return _finalize("closed_pending", "odds-missing", prev, state, diag, now)
            return _finalize("closed", "betting-closed", prev, state, diag, now)
        return _finalize("odds_missing", "odds-missing", None, state, diag, now)

    state.odds_missing_since = None
    state.last_active_odds = extracted_odds
    state.last_status = "active"
    return _finalize("active", "active", None, state, diag, now)


def _finalize(
    status: str,
    reason: str,
    previous_odds: float | None,
    state: X10StatusState,
    diag: X10StatusDiagnostics,
    now: float,
) -> X10StatusResult:
    if status == "active":
        state.last_status = "active"
        state.odds_missing_since = None
    elif status in {"closed", "suspended", "disabled", "closed_pending"}:
        if previous_odds is None and state.last_active_odds is not None:
            previous_odds = state.last_active_odds
        state.last_status = status
        if status != "closed_pending":
            state.odds_missing_since = None
    else:
        state.last_status = status

    diag.parsed_status = status
    diag.reason = reason
    return X10StatusResult(
        status=status,
        reason=reason,
        previous_odds=previous_odds,
        diagnostics=diag,
    )
