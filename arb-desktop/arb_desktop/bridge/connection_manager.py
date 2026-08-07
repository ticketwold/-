from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus
from arb_desktop.bridge.message_models import (
    BetSlipState,
    BridgeConnectionState,
    BridgeStatus,
    SlipUpdateMessage,
    StatusMessage,
    slip_state_from_raw,
    tab_state_from_raw,
)


ACTIVE_GUARD_SEC = 3.0


@dataclass
class ConnectionManager:
    """확장프로그램 연결 상태 및 최신 BetSlip 스냅샷."""

    token: str
    on_status_change: Callable[[BridgeStatus], None] | None = None
    on_slip_update: Callable[[str, BetSlipReadResult], None] | None = None
    on_debug: Callable[[dict[str, Any]], None] | None = None
    on_stake_input_changed: Callable[[], None] | None = None
    bridge_connected: bool = False
    auth_state: BridgeConnectionState = BridgeConnectionState.WAITING
    paired_extension_id: str = ""
    last_connected_at: float = 0.0
    bc_tab: str = "not_found"
    x10_tab: str = "not_found"
    bc_betslip: str = "empty"
    x10_betslip: str = "empty"
    bc_slip: BetSlipReadResult | None = None
    x10_slip: BetSlipReadResult | None = None
    last_x10_debug: dict[str, Any] | None = None
    last_bc_stake_debug: dict[str, Any] | None = None
    _last_active_at: dict[str, float] = field(default_factory=lambda: {"bc": 0.0, "x10": 0.0})
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def status(self) -> BridgeStatus:
        bridge = self.auth_state
        if self.bridge_connected:
            bridge = BridgeConnectionState.CONNECTED
        last_at = ""
        if self.last_connected_at:
            last_at = datetime.fromtimestamp(self.last_connected_at).strftime("%Y-%m-%d %H:%M:%S")
        return BridgeStatus(
            bridge=bridge,
            bc_tab=tab_state_from_raw(self.bc_tab),
            x10_tab=tab_state_from_raw(self.x10_tab),
            bc_betslip=slip_state_from_raw(self.bc_betslip),
            x10_betslip=slip_state_from_raw(self.x10_betslip),
            extension_id=self.paired_extension_id,
            last_connected_at=last_at,
        )

    def _notify_status(self) -> None:
        if self.on_status_change:
            self.on_status_change(self.status())

    def set_bridge_connected(self, connected: bool, *, extension_id: str = "") -> None:
        self.bridge_connected = connected
        if connected:
            self.auth_state = BridgeConnectionState.CONNECTED
            if extension_id:
                self.paired_extension_id = extension_id
            self.last_connected_at = time.time()
        else:
            self.auth_state = BridgeConnectionState.WAITING
            self.bc_betslip = "empty"
            self.x10_betslip = "empty"
        self._notify_status()

    def set_auth_failed(self, extension_id: str | None = None) -> None:
        self.bridge_connected = False
        self.auth_state = BridgeConnectionState.AUTH_FAILED
        if extension_id:
            self.paired_extension_id = extension_id
        self.bc_betslip = "empty"
        self.x10_betslip = "empty"
        self._notify_status()

    def apply_status_message(self, message: StatusMessage) -> None:
        self.bridge_connected = message.bridge_connected
        self.bc_tab = message.bc_tab
        self.x10_tab = message.x10_tab
        self.bc_betslip = message.bc_betslip
        self.x10_betslip = message.x10_betslip
        self._notify_status()

    def apply_slip_update(self, message: SlipUpdateMessage) -> BetSlipReadResult | None:
        import logging

        log = logging.getLogger(__name__)
        site_key = "bc" if message.site == "bc" else "x10"
        site = "bc" if message.site == "bc" else "bti"
        read = _result_to_read(site, message.result, frame_url=message.frame_url)
        if message.site_state:
            read.raw = {**read.raw, "site_state": message.site_state}
        if message.tab_id is not None:
            read.raw = {**read.raw, "tab_id": message.tab_id, "frame_id": message.frame_id}

        prio = _slip_priority(read)
        if prio >= 100:
            self._last_active_at[site_key] = time.time()

        current = self.bc_slip if site_key == "bc" else self.x10_slip
        last_active = self._last_active_at.get(site_key, 0.0)
        if last_active and time.time() - last_active < ACTIVE_GUARD_SEC and prio < 80:
            log.info("[PYTHON SKIP] active-guard site=%s prio=%s", site_key, prio)
            return None
        if not _should_replace_slip(current, read):
            log.info(
                "[PYTHON SKIP] lower-priority site=%s current_score=%s new_score=%s",
                site_key,
                _slip_score(current),
                _slip_score(read),
            )
            return None

        old_status = current.first.status.value if current and current.first else "EMPTY"
        old_odds = current.first.odds if current and current.first else None
        new_status = read.first.status.value if read.first else "EMPTY"
        new_odds = read.first.odds if read.first else None
        log.info(
            "[GUI APPLY] site=%s old_status=%s new_status=%s old_odds=%s new_odds=%s source_frame=%s",
            site_key,
            old_status,
            new_status,
            old_odds,
            new_odds,
            message.frame_url,
        )

        if site_key == "bc":
            self.bc_slip = read
            self.bc_tab = "found"
            self.bc_betslip = _slip_state_from_read(read)
        else:
            self.x10_slip = read
            self.x10_tab = "found"
            self.x10_betslip = _slip_state_from_read(read)

        self._notify_status()
        if self.on_slip_update:
            self.on_slip_update(site, read)
        return read

    def apply_debug(self, payload: dict[str, Any]) -> None:
        site = str(payload.get("site") or "").lower()
        block = str(payload.get("block") or "").upper()
        if site in {"x10", "bti"}:
            self.last_x10_debug = payload
        if block in {"BC STAKE INPUT FOUND", "BC STAKE INPUT NOT FOUND", "BC INPUT SCAN"} or block.startswith("BC STAKE"):
            self.last_bc_stake_debug = payload
        if self.on_debug:
            self.on_debug(payload)

    def apply_stake_input_changed(self, _payload: dict[str, Any]) -> None:
        if self.on_stake_input_changed:
            self.on_stake_input_changed()

    def get_bc_stake_debug(self) -> dict[str, Any] | None:
        return self.last_bc_stake_debug

    def get_x10_debug(self) -> dict[str, Any] | None:
        return self.last_x10_debug

    def get_bc_read(self) -> BetSlipReadResult:
        return self.bc_slip or _empty_read("bc")

    def get_bti_read(self) -> BetSlipReadResult:
        return self.x10_slip or _empty_read("bti")

    def is_ready_for_scan(self) -> bool:
        status = self.status()
        return (
            status.bridge == BridgeConnectionState.CONNECTED
            and status.bc_tab == tab_state_from_raw("found")
            and status.x10_tab == tab_state_from_raw("found")
        )


def _slip_state_from_read(read: BetSlipReadResult) -> str:
    from arb_desktop.ui.site_status import slip_status_from_read

    status = slip_status_from_read(read)
    if status.value == "ACTIVE":
        return "active"
    if status.value in {"SUSPENDED", "CLOSED"}:
        return "suspended"
    if status.value == "ODDS_MISSING":
        return "empty"
    return "empty"


def _slip_priority(read: BetSlipReadResult | None) -> int:
    if not read:
        return 0
    if not read.empty and read.first:
        status = read.first.status
        if status == SlipStatus.ACTIVE:
            return 100
        if status in {SlipStatus.CLOSED, SlipStatus.SUSPENDED}:
            return 80
        if status == SlipStatus.ODDS_MISSING:
            return 60
        return 55
    if read.raw.get("slip_root_found") == "YES" or read.raw.get("slip_count"):
        return 60
    if read.reason == "empty-slip":
        return 10
    if read.reason == "no-slip-root":
        return 0
    return 5


def _slip_score(read: BetSlipReadResult | None) -> int:
    if not read:
        return 0
    if not read.empty and read.first:
        score = 100
        if read.first.odds:
            score += 10
        if read.first.event:
            score += 5
        if read.first.selection:
            score += 5
        return score
    if read.reason == "no-slip-root":
        return 1
    if read.reason == "empty-slip":
        return 2
    return 3


def _should_replace_slip(current: BetSlipReadResult | None, new: BetSlipReadResult) -> bool:
    return _slip_score(new) >= _slip_score(current)


def _empty_read(site: str) -> BetSlipReadResult:
    return BetSlipReadResult(site=site, ok=False, empty=True, reason="no-bridge-data")


def _result_to_read(site: str, result: dict[str, Any], *, frame_url: str = "") -> BetSlipReadResult:
    from arb_desktop.betslip.models import BetSlipItem

    items = [
        BetSlipItem.from_dict(site, item, frame_url=frame_url or str(result.get("frame_url") or ""))
        for item in result.get("items") or []
    ]
    return BetSlipReadResult(
        site=site,
        ok=bool(result.get("ok")),
        empty=bool(result.get("empty", not items)),
        items=items,
        frame_url=frame_url or str(result.get("frame_url") or ""),
        source=str(result.get("source") or "bridge"),
        container_selector=str(result.get("container_selector") or ""),
        reason=str(result.get("reason") or ""),
        raw=result,
    )
