from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class BridgeConnectionState(str, Enum):
    CONNECTED = "CONNECTED"
    DISCONNECTED = "DISCONNECTED"
    WAITING = "WAITING"
    AUTH_FAILED = "AUTH_FAILED"


class TabState(str, Enum):
    FOUND = "FOUND"
    NOT_FOUND = "NOT_FOUND"


class BetSlipState(str, Enum):
    ACTIVE = "ACTIVE"
    EMPTY = "EMPTY"
    SUSPENDED = "SUSPENDED"


class SlipUpdateMessage(BaseModel):
    type: str = "slip_update"
    site: str
    frame_url: str = ""
    tab_id: int | None = None
    frame_id: int | None = None
    frame_depth: int | None = None
    site_state: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] = Field(default_factory=dict)


class StatusMessage(BaseModel):
    type: str = "status"
    bridge_connected: bool = False
    bc_tab: str = "not_found"
    x10_tab: str = "not_found"
    bc_betslip: str = "empty"
    x10_betslip: str = "empty"


class BridgeStatus(BaseModel):
    bridge: BridgeConnectionState = BridgeConnectionState.WAITING
    bc_tab: TabState = TabState.NOT_FOUND
    x10_tab: TabState = TabState.NOT_FOUND
    bc_betslip: BetSlipState = BetSlipState.EMPTY
    x10_betslip: BetSlipState = BetSlipState.EMPTY
    extension_id: str = ""
    last_connected_at: str = ""

    def format_lines(self) -> list[str]:
        def tab(value: TabState) -> str:
            return "FOUND" if value == TabState.FOUND else "NOT FOUND"

        def slip(value: BetSlipState) -> str:
            return value.value

        bridge_label = self.bridge.value
        if self.bridge == BridgeConnectionState.CONNECTED:
            bridge_label = "CONNECTED"
        elif self.bridge == BridgeConnectionState.WAITING:
            bridge_label = "WAITING"
        elif self.bridge == BridgeConnectionState.AUTH_FAILED:
            bridge_label = "AUTH FAILED"

        lines = [
            f"Chrome Bridge: {bridge_label}",
            f"BC.Game tab: {tab(self.bc_tab)}",
            f"x10x10s tab: {tab(self.x10_tab)}",
            f"BC BetSlip: {slip(self.bc_betslip)}",
            f"x10 BetSlip: {slip(self.x10_betslip)}",
        ]
        if self.extension_id:
            short = f"{self.extension_id[:8]}…" if len(self.extension_id) > 10 else self.extension_id
            lines.append(f"Extension: {short}")
        if self.last_connected_at:
            lines.append(f"Last connected: {self.last_connected_at}")
        return lines

    def format_block(self) -> str:
        return "\n".join(self.format_lines())


def tab_state_from_raw(value: str) -> TabState:
    return TabState.FOUND if str(value).lower() == "found" else TabState.NOT_FOUND


def slip_state_from_raw(value: str) -> BetSlipState:
    raw = str(value).lower()
    if raw == "active":
        return BetSlipState.ACTIVE
    if raw == "suspended":
        return BetSlipState.SUSPENDED
    return BetSlipState.EMPTY
