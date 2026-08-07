from __future__ import annotations

import time
from dataclasses import dataclass, field

from arb_desktop.betslip.models import BetSlipReadResult, SlipStatus

SITE_LABELS: dict[SlipStatus, str] = {
    SlipStatus.ACTIVE: "ACTIVE",
    SlipStatus.CLOSED: "배팅 닫힘",
    SlipStatus.SUSPENDED: "일시 정지",
    SlipStatus.DISABLED: "배팅 불가",
    SlipStatus.EMPTY: "카트 없음",
    SlipStatus.ODDS_MISSING: "배당 없음",
    SlipStatus.ERROR: "오류",
    SlipStatus.NEEDS_REVIEW: "확인 필요",
}


def slip_status_from_read(read: BetSlipReadResult) -> SlipStatus:
    if read.empty or not read.first:
        return SlipStatus.EMPTY
    item = read.first
    if item.status in {
        SlipStatus.CLOSED,
        SlipStatus.SUSPENDED,
        SlipStatus.DISABLED,
        SlipStatus.ODDS_MISSING,
        SlipStatus.ACTIVE,
    }:
        return item.status
    if item.odds is None and item.status != SlipStatus.ACTIVE:
        return SlipStatus.ODDS_MISSING
    return item.status


def site_label(status: SlipStatus) -> str:
    return SITE_LABELS.get(status, status.value)


def wait_reason_for_site(site: str, status: SlipStatus) -> str | None:
    if status == SlipStatus.ACTIVE:
        return None
    prefix = "텐텐벳" if site in {"bti", "x10"} else "BC.Game"
    label = site_label(status)
    if label == "ACTIVE":
        return None
    return f"{prefix} {label}"


@dataclass
class SiteStatusDebouncer:
    """최소 2회 연속 또는 200ms 이상 동일 상태일 때 확정."""

    min_hits: int = 2
    min_ms: float = 200.0
    _pending: dict[str, tuple[SlipStatus, int, float]] = field(default_factory=dict)
    _confirmed: dict[str, SlipStatus] = field(default_factory=dict)

    def update(self, site: str, status: SlipStatus) -> SlipStatus:
        now = time.monotonic()
        if status == SlipStatus.ACTIVE:
            self._confirmed[site] = SlipStatus.ACTIVE
            self._pending[site] = (status, self.min_hits, now)
            return SlipStatus.ACTIVE

        pending = self._pending.get(site)
        if pending and pending[0] == status:
            hits = pending[1] + 1
            since = pending[2]
        else:
            hits = 1
            since = now
        self._pending[site] = (status, hits, since)
        elapsed_ms = (now - since) * 1000
        if hits >= self.min_hits or elapsed_ms >= self.min_ms:
            self._confirmed[site] = status
        return self._confirmed.get(site, SlipStatus.EMPTY)

    def confirmed(self, site: str) -> SlipStatus:
        return self._confirmed.get(site, SlipStatus.EMPTY)

    def reset(self) -> None:
        self._pending.clear()
        self._confirmed.clear()


def both_sites_active(bc: SlipStatus, x10: SlipStatus) -> bool:
    return bc == SlipStatus.ACTIVE and x10 == SlipStatus.ACTIVE
