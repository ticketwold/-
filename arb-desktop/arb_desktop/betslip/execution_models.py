from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from arb_desktop.betslip.models import (
    ArbitrageResult,
    BetSlipItem,
    BetSlipScanResult,
    MatchCheckResult,
    SlipStatus,
)


class ExecutionStage(str, Enum):
    SCAN = "SCAN"
    VERIFY = "VERIFY"
    CALCULATE = "CALCULATE"
    RECHECK = "RECHECK"
    INPUT = "INPUT"
    VERIFY_INPUT = "VERIFY_INPUT"
    READY = "READY"
    LOCK_BROKEN = "LOCK_BROKEN"
    RECHECK_FAILED = "RECHECK_FAILED"
    INPUT_FAILED = "INPUT_FAILED"
    ABORTED = "ABORTED"


class LockState(str, Enum):
    OK = "OK"
    BROKEN = "BROKEN"
    UNLOCKED = "UNLOCKED"


@dataclass(slots=True)
class LockedSnapshot:
    """처음 읽은 5개 필드 잠금."""

    event: str
    market: str
    selection: str
    odds: float | None
    stake: float | None
    status: SlipStatus

    @classmethod
    def from_item(cls, item: BetSlipItem) -> LockedSnapshot:
        return cls(
            event=item.event,
            market=item.market,
            selection=item.selection,
            odds=item.odds,
            stake=item.stake,
            status=item.status,
        )

    def lock_fingerprint(self) -> str:
        """Lock 대상 5필드 — event/market/selection/odds/stake."""
        return "|".join(
            [
                self.event,
                self.market,
                self.selection,
                str(self.odds),
                str(self.stake),
            ]
        )


@dataclass(slots=True)
class BetSlipLock:
    bc: LockedSnapshot
    bti: LockedSnapshot
    state: LockState = LockState.OK

    @classmethod
    def from_scan(cls, scan: BetSlipScanResult) -> BetSlipLock | None:
        if not scan.bc.first or not scan.bti.first:
            return None
        return cls(
            bc=LockedSnapshot.from_item(scan.bc.first),
            bti=LockedSnapshot.from_item(scan.bti.first),
        )

    def check(self, bc_item: BetSlipItem | None, bti_item: BetSlipItem | None) -> tuple[bool, str]:
        if self.state == LockState.BROKEN:
            return False, "lock-already-broken"
        if not bc_item or not bti_item:
            return False, "slip-missing"
        bc_now = LockedSnapshot.from_item(bc_item)
        bti_now = LockedSnapshot.from_item(bti_item)
        if bc_now.lock_fingerprint() != self.bc.lock_fingerprint():
            self.state = LockState.BROKEN
            return False, f"bc-lock-broken:{bc_now.lock_fingerprint()}!={self.bc.lock_fingerprint()}"
        if bti_now.lock_fingerprint() != self.bti.lock_fingerprint():
            self.state = LockState.BROKEN
            return False, f"bti-lock-broken:{bti_now.lock_fingerprint()}!={self.bti.lock_fingerprint()}"
        return True, "ok"

    def recheck(self, bc_item: BetSlipItem | None, bti_item: BetSlipItem | None) -> tuple[bool, str]:
        """금액 입력 직전 — event/market/selection/odds/status 비교."""
        if not bc_item or not bti_item:
            return False, "slip-missing"
        for label, locked, current in (
            ("bc", self.bc, bc_item),
            ("bti", self.bti, bti_item),
        ):
            snap = LockedSnapshot.from_item(current)
            ref = locked
            if snap.event != ref.event:
                return False, f"{label}-event-mismatch"
            if snap.market != ref.market:
                return False, f"{label}-market-mismatch"
            if snap.selection != ref.selection:
                return False, f"{label}-selection-mismatch"
            if snap.odds != ref.odds:
                return False, f"{label}-odds-mismatch"
            if snap.status != ref.status:
                return False, f"{label}-status-mismatch"
        return True, "ok"


@dataclass(slots=True)
class StageLatency:
    scan_ms: float = 0.0
    verify_ms: float = 0.0
    calculate_ms: float = 0.0
    recheck_ms: float = 0.0
    input_ms: float = 0.0
    verify_input_ms: float = 0.0
    total_ms: float = 0.0

    def log_lines(self) -> list[str]:
        return [
            f"SCAN: {self.scan_ms:.1f}ms",
            f"VERIFY: {self.verify_ms:.1f}ms",
            f"CALCULATE: {self.calculate_ms:.1f}ms",
            f"RECHECK: {self.recheck_ms:.1f}ms",
            f"INPUT: {self.input_ms:.1f}ms",
            f"VERIFY INPUT: {self.verify_input_ms:.1f}ms",
            f"TOTAL: {self.total_ms:.1f}ms",
        ]


@dataclass(slots=True)
class LocatorCacheEntry:
    site: str
    frame_url: str
    container_selector: str
    stake_selector: str
    dom_hash: str = ""


@dataclass(slots=True)
class OverlayState:
    bc_status: str = "-"
    bc_odds: str = "-"
    bti_status: str = "-"
    bti_odds: str = "-"
    profit: str = "-"
    match_ok: str = "-"
    network_ok: str = "-"
    dom_ok: str = "-"
    lock_ok: str = "-"
    stage: str = "-"


@dataclass(slots=True)
class PipelineResult:
    stage: ExecutionStage
    ok: bool
    scan: BetSlipScanResult | None = None
    lock: BetSlipLock | None = None
    arbitrage: ArbitrageResult | None = None
    latency: StageLatency = field(default_factory=StageLatency)
    reason: str = ""
    bc_stake_input: float | None = None
    bti_stake_input: float | None = None
    raw: dict[str, Any] = field(default_factory=dict)
