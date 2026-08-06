from __future__ import annotations

from time import perf_counter

from arb_desktop.betslip.dom_runtime import (
    get_dom_hash,
    read_stake_in_page,
    set_stake_in_page,
    setup_monitors,
    update_overlay,
    BC_FRAME_HINTS,
    BTI_FRAME_HINTS,
)
from arb_desktop.betslip.execution_models import (
    BetSlipLock,
    ExecutionStage,
    OverlayState,
    PipelineResult,
    StageLatency,
)
from arb_desktop.betslip.locator_cache import StableLocatorCache
from arb_desktop.betslip.matcher import apply_network_verification, calculate_arbitrage, check_slip_pair
from arb_desktop.betslip.models import BetSlipScanResult, SlipStatus
from arb_desktop.betslip.readers.dom import read_bc_betslip, read_bti_betslip
from arb_desktop.betslip.scanner import BetSlipScanner
from arb_desktop.config import settings
from arb_desktop.scanners.playwright.session import BrowserSession


class AutoBetPipeline:
    """SCAN → VERIFY → CALCULATE → RECHECK → INPUT → VERIFY INPUT → READY"""

    def __init__(self, session: BrowserSession) -> None:
        self._session = session
        self._scanner = BetSlipScanner(session)
        self._locator_cache = StableLocatorCache(max_retries=settings.auto_retry_max)
        self._lock: BetSlipLock | None = None
        self._debug = False

    async def _overlay(self, stage: ExecutionStage, scan: BetSlipScanResult | None, lock_ok: str = "OK") -> None:
        state = OverlayState(stage=stage.value, lock_ok=lock_ok, dom_ok="OK", network_ok="OK")
        if scan:
            if scan.bc.first:
                state.bc_status = scan.bc.first.status.value
                state.bc_odds = f"{scan.bc.first.odds:.2f}" if scan.bc.first.odds else "-"
            if scan.bti.first:
                state.bti_status = scan.bti.first.status.value
                state.bti_odds = f"{scan.bti.first.odds:.2f}" if scan.bti.first.odds else "-"
            state.match_ok = "OK" if scan.match.safe_to_calculate else "FAIL"
            state.network_ok = "OK" if scan.match.network_verified else "SKIP"
            if scan.arbitrage and scan.arbitrage.profit_rate is not None:
                state.profit = f"{scan.arbitrage.profit_rate:.2f}%"
        if self._session.bc_page:
            await update_overlay(self._session.bc_page, state, BC_FRAME_HINTS)
        if self._session.bti_page:
            await update_overlay(self._session.bti_page, state, BTI_FRAME_HINTS)

    async def _scan(self) -> tuple[BetSlipScanResult, float]:
        t0 = perf_counter()
        await setup_monitors(self._session.bc_page, self._session.bti_page)
        scan = await self._scanner.scan(debug=self._debug, cart_wait_sec=0)
        ms = (perf_counter() - t0) * 1000
        return scan, ms

    async def _fresh_read(self) -> BetSlipScanResult:
        bc = await read_bc_betslip(self._session.bc_page)
        bti = await read_bti_betslip(self._session.bti_page, wait_sec=0)
        match = check_slip_pair(bc, bti)
        match = apply_network_verification(
            match,
            bc_dom_odds=bc.first.odds if bc.first else None,
            bti_dom_odds=bti.first.odds if bti.first else None,
            bc_network_odds=None,
            bti_network_odds=None,
            tolerance=settings.betslip_network_tolerance,
        )
        arb = None
        if match.safe_to_calculate and bc.first and bti.first:
            arb = calculate_arbitrage(bc.first, bti.first)
        return BetSlipScanResult(bc=bc, bti=bti, match=match, arbitrage=arb)

    async def run(self, *, enable_input: bool = True, debug: bool = False) -> PipelineResult:
        self._debug = debug
        total_start = perf_counter()
        latency = StageLatency()

        # SCAN
        scan, latency.scan_ms = await self._scan()
        await self._overlay(ExecutionStage.SCAN, scan)

        if scan.bc.empty or scan.bti.empty or not scan.bc.first or not scan.bti.first:
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(
                stage=ExecutionStage.ABORTED,
                ok=False,
                scan=scan,
                latency=latency,
                reason="empty-slip",
            )

        # LOCK
        self._lock = BetSlipLock.from_scan(scan)
        if not self._lock:
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(stage=ExecutionStage.ABORTED, ok=False, scan=scan, latency=latency, reason="lock-failed")

        # VERIFY
        t0 = perf_counter()
        if not scan.match.safe_to_calculate:
            latency.verify_ms = (perf_counter() - t0) * 1000
            latency.total_ms = (perf_counter() - total_start) * 1000
            await self._overlay(ExecutionStage.VERIFY, scan, lock_ok="OK")
            return PipelineResult(
                stage=ExecutionStage.ABORTED,
                ok=False,
                scan=scan,
                lock=self._lock,
                latency=latency,
                reason=f"verify-failed:{scan.match.reason}",
            )
        if scan.bc.first.status != SlipStatus.ACTIVE or scan.bti.first.status != SlipStatus.ACTIVE:
            latency.verify_ms = (perf_counter() - t0) * 1000
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(stage=ExecutionStage.ABORTED, ok=False, scan=scan, lock=self._lock, latency=latency, reason="inactive-status")
        latency.verify_ms = (perf_counter() - t0) * 1000
        await self._overlay(ExecutionStage.VERIFY, scan)

        # CALCULATE
        t0 = perf_counter()
        arb = scan.arbitrage
        if not arb or not arb.arb_possible or arb.stake_a is None or arb.stake_b is None:
            latency.calculate_ms = (perf_counter() - t0) * 1000
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(stage=ExecutionStage.ABORTED, ok=False, scan=scan, lock=self._lock, latency=latency, reason="no-arbitrage")
        latency.calculate_ms = (perf_counter() - t0) * 1000
        await self._overlay(ExecutionStage.CALCULATE, scan)

        if not enable_input or settings.dry_run:
            latency.total_ms = (perf_counter() - total_start) * 1000
            await self._overlay(ExecutionStage.READY, scan)
            return PipelineResult(
                stage=ExecutionStage.READY,
                ok=True,
                scan=scan,
                lock=self._lock,
                arbitrage=arb,
                latency=latency,
                reason="dry-run-ready",
            )

        # LOCK check before recheck
        fresh = await self._fresh_read()
        ok_lock, lock_reason = self._lock.check(fresh.bc.first, fresh.bti.first)
        if not ok_lock:
            await self._overlay(ExecutionStage.LOCK_BROKEN, fresh, lock_ok="BROKEN")
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(
                stage=ExecutionStage.LOCK_BROKEN,
                ok=False,
                scan=fresh,
                lock=self._lock,
                arbitrage=arb,
                latency=latency,
                reason=lock_reason,
            )

        # RECHECK (odds recheck before input)
        t0 = perf_counter()
        recheck_ok, recheck_reason = self._lock.recheck(fresh.bc.first, fresh.bti.first)
        latency.recheck_ms = (perf_counter() - t0) * 1000
        if not recheck_ok:
            await self._overlay(ExecutionStage.RECHECK_FAILED, fresh, lock_ok="OK")
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(
                stage=ExecutionStage.RECHECK_FAILED,
                ok=False,
                scan=fresh,
                lock=self._lock,
                arbitrage=arb,
                latency=latency,
                reason=recheck_reason,
            )
        await self._overlay(ExecutionStage.RECHECK, fresh)

        # INPUT with retry + DOM hash invalidation
        t0 = perf_counter()
        bc_container = fresh.bc.container_selector or (fresh.bc.first.container_selector if fresh.bc.first else "")
        bti_container = fresh.bti.container_selector or (fresh.bti.first.container_selector if fresh.bti.first else "")

        bc_result = await set_stake_in_page(
            self._session.bc_page,
            site="bc",
            amount=arb.stake_a,
            hints=BC_FRAME_HINTS,
            cache=self._locator_cache,
            container_selector=bc_container,
            max_retries=settings.auto_retry_max,
        )
        bti_result = await set_stake_in_page(
            self._session.bti_page,
            site="bti",
            amount=arb.stake_b,
            hints=BTI_FRAME_HINTS,
            cache=self._locator_cache,
            container_selector=bti_container,
            max_retries=settings.auto_retry_max,
        )
        latency.input_ms = (perf_counter() - t0) * 1000

        if not bc_result.get("ok") or not bti_result.get("ok"):
            await self._overlay(ExecutionStage.INPUT_FAILED, fresh, lock_ok="OK")
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(
                stage=ExecutionStage.INPUT_FAILED,
                ok=False,
                scan=fresh,
                lock=self._lock,
                arbitrage=arb,
                latency=latency,
                reason=f"bc:{bc_result.get('reason')};bti:{bti_result.get('reason')}",
                raw={"bc_input": bc_result, "bti_input": bti_result},
            )

        # VERIFY INPUT
        t0 = perf_counter()
        bc_read = await read_stake_in_page(
            self._session.bc_page, site="bc", hints=BC_FRAME_HINTS, container_selector=bc_container
        )
        bti_read = await read_stake_in_page(
            self._session.bti_page, site="bti", hints=BTI_FRAME_HINTS, container_selector=bti_container
        )
        bc_ok = bc_read == arb.stake_a
        bti_ok = bti_read == arb.stake_b
        latency.verify_input_ms = (perf_counter() - t0) * 1000

        if not bc_ok or not bti_ok:
            await self._overlay(ExecutionStage.INPUT_FAILED, fresh, lock_ok="OK")
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(
                stage=ExecutionStage.INPUT_FAILED,
                ok=False,
                scan=fresh,
                lock=self._lock,
                arbitrage=arb,
                latency=latency,
                reason=f"verify-input:bc={bc_read}!={arb.stake_a},bti={bti_read}!={arb.stake_b}",
                bc_stake_input=bc_read,
                bti_stake_input=bti_read,
            )

        # Final content check (stake는 의도적 변경 — recheck 필드만)
        final = await self._fresh_read()
        ok_lock, lock_reason = self._lock.recheck(final.bc.first, final.bti.first)
        if not ok_lock:
            await self._overlay(ExecutionStage.LOCK_BROKEN, final, lock_ok="BROKEN")
            latency.total_ms = (perf_counter() - total_start) * 1000
            return PipelineResult(
                stage=ExecutionStage.LOCK_BROKEN,
                ok=False,
                scan=final,
                lock=self._lock,
                arbitrage=arb,
                latency=latency,
                reason=lock_reason,
                bc_stake_input=bc_read,
                bti_stake_input=bti_read,
            )

        latency.total_ms = (perf_counter() - total_start) * 1000
        await self._overlay(ExecutionStage.READY, final)

        # READY — 실제 Bet 클릭은 live_execution_enabled + 사용자 확인 시에만
        return PipelineResult(
            stage=ExecutionStage.READY,
            ok=True,
            scan=final,
            lock=self._lock,
            arbitrage=arb,
            latency=latency,
            reason="ready-no-bet-click" if not settings.live_execution_enabled else "ready-await-user-bet",
            bc_stake_input=bc_read,
            bti_stake_input=bti_read,
            raw={
                "bc_dom_hash": await get_dom_hash(self._session.bc_page, BC_FRAME_HINTS),
                "bti_dom_hash": await get_dom_hash(self._session.bti_page, BTI_FRAME_HINTS),
            },
        )
