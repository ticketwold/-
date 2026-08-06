from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable

from arb_desktop.betslip.models import BetSlipReadResult
from arb_desktop.bridge.message_models import (
    BetSlipState,
    BridgeConnectionState,
    BridgeStatus,
    SlipUpdateMessage,
    StatusMessage,
    slip_state_from_raw,
    tab_state_from_raw,
)


@dataclass
class ConnectionManager:
    """확장프로그램 연결 상태 및 최신 BetSlip 스냅샷."""

    token: str
    on_status_change: Callable[[BridgeStatus], None] | None = None
    on_slip_update: Callable[[str, BetSlipReadResult], None] | None = None
    on_debug: Callable[[dict[str, Any]], None] | None = None
    bridge_connected: bool = False
    bc_tab: str = "not_found"
    x10_tab: str = "not_found"
    bc_betslip: str = "empty"
    x10_betslip: str = "empty"
    bc_slip: BetSlipReadResult | None = None
    x10_slip: BetSlipReadResult | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def status(self) -> BridgeStatus:
        return BridgeStatus(
            bridge=BridgeConnectionState.CONNECTED if self.bridge_connected else BridgeConnectionState.DISCONNECTED,
            bc_tab=tab_state_from_raw(self.bc_tab),
            x10_tab=tab_state_from_raw(self.x10_tab),
            bc_betslip=slip_state_from_raw(self.bc_betslip),
            x10_betslip=slip_state_from_raw(self.x10_betslip),
        )

    def _notify_status(self) -> None:
        if self.on_status_change:
            self.on_status_change(self.status())

    def set_bridge_connected(self, connected: bool) -> None:
        self.bridge_connected = connected
        if not connected:
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
        site_key = "bc" if message.site == "bc" else "x10"
        site = "bc" if message.site == "bc" else "bti"
        read = _result_to_read(site, message.result, frame_url=message.frame_url)

        current = self.bc_slip if site_key == "bc" else self.x10_slip
        if not _should_replace_slip(current, read):
            return None

        if site_key == "bc":
            self.bc_slip = read
            self.bc_tab = "found"
            self.bc_betslip = "active" if read.first and read.first.status.value == "ACTIVE" else "empty"
        else:
            self.x10_slip = read
            self.x10_tab = "found"
            self.x10_betslip = "active" if read.first and read.first.status.value == "ACTIVE" else "empty"

        self._notify_status()
        if self.on_slip_update:
            self.on_slip_update(site, read)
        return read

    def apply_debug(self, payload: dict[str, Any]) -> None:
        if self.on_debug:
            self.on_debug(payload)

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
