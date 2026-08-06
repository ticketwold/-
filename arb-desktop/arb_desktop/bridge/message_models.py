from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class BridgeConnectionState(str, Enum):
    CONNECTED = "CONNECTED"
    DISCONNECTED = "DISCONNECTED"


class TabState(str, Enum):
    FOUND = "FOUND"
    NOT_FOUND = "NOT_FOUND"


class BetSlipState(str, Enum):
    ACTIVE = "ACTIVE"
    EMPTY = "EMPTY"


class SlipUpdateMessage(BaseModel):
    type: str = "slip_update"
    site: str
    frame_url: str = ""
    result: dict[str, Any] = Field(default_factory=dict)


class StatusMessage(BaseModel):
    type: str = "status"
    bridge_connected: bool = False
    bc_tab: str = "not_found"
    x10_tab: str = "not_found"
    bc_betslip: str = "empty"
    x10_betslip: str = "empty"


class BridgeStatus(BaseModel):
    bridge: BridgeConnectionState = BridgeConnectionState.DISCONNECTED
    bc_tab: TabState = TabState.NOT_FOUND
    x10_tab: TabState = TabState.NOT_FOUND
    bc_betslip: BetSlipState = BetSlipState.EMPTY
    x10_betslip: BetSlipState = BetSlipState.EMPTY

    def format_lines(self) -> list[str]:
        def tab(value: TabState) -> str:
            return "FOUND" if value == TabState.FOUND else "NOT FOUND"

        def slip(value: BetSlipState) -> str:
            return value.value

        return [
            f"Chrome Bridge: {self.bridge.value}",
            f"BC.Game tab: {tab(self.bc_tab)}",
            f"x10x10s tab: {tab(self.x10_tab)}",
            f"BC BetSlip: {slip(self.bc_betslip)}",
            f"x10 BetSlip: {slip(self.x10_betslip)}",
        ]

    def format_block(self) -> str:
        return "\n".join(self.format_lines())


def tab_state_from_raw(value: str) -> TabState:
    return TabState.FOUND if str(value).lower() == "found" else TabState.NOT_FOUND


def slip_state_from_raw(value: str) -> BetSlipState:
    return BetSlipState.ACTIVE if str(value).lower() == "active" else BetSlipState.EMPTY
