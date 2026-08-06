from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class SlipStatus(str, Enum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    CLOSED = "closed"
    ODDS_MISSING = "odds_missing"
    EMPTY = "empty"
    ERROR = "error"


@dataclass(slots=True)
class BetSlipItem:
    site: str
    event: str = ""
    selection: str = ""
    odds: float | None = None
    status: SlipStatus = SlipStatus.EMPTY
    stake: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, site: str, data: dict[str, Any]) -> BetSlipItem:
        status_raw = str(data.get("status") or SlipStatus.EMPTY.value)
        try:
            status = SlipStatus(status_raw)
        except ValueError:
            status = SlipStatus.ERROR

        odds_raw = data.get("odds")
        odds = float(odds_raw) if odds_raw is not None and odds_raw != "" else None

        stake_raw = data.get("stake")
        stake = float(stake_raw) if stake_raw is not None and stake_raw != "" and float(stake_raw) > 0 else None

        return cls(
            site=site,
            event=str(data.get("event") or "").strip(),
            selection=str(data.get("selection") or "").strip(),
            odds=odds,
            status=status,
            stake=stake,
            raw=data,
        )


@dataclass(slots=True)
class BetSlipReadResult:
    site: str
    ok: bool
    empty: bool = True
    items: list[BetSlipItem] = field(default_factory=list)
    frame_url: str = ""
    source: str = "dom"
    reason: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def first(self) -> BetSlipItem | None:
        return self.items[0] if self.items else None
