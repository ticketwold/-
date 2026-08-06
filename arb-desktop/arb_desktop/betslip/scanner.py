from __future__ import annotations

from arb_desktop.betslip.matcher import apply_network_verification, calculate_arbitrage, check_slip_pair
from arb_desktop.betslip.models import BetSlipScanResult
from arb_desktop.betslip.readers.dom import read_bc_betslip, read_bti_betslip
from arb_desktop.config import settings
from arb_desktop.scanners.playwright.session import BrowserSession


class BetSlipScanner:
    """BetSlip-first 메인 스캐너 — 배팅카트 DOM만 읽습니다."""

    def __init__(self, session: BrowserSession) -> None:
        self._session = session
        self._bc_network_odds: float | None = None
        self._bti_network_odds: float | None = None

    async def scan(self) -> BetSlipScanResult:
        bc = await read_bc_betslip(self._session.bc_page)
        bti = await read_bti_betslip(self._session.bti_page)

        match = check_slip_pair(bc, bti)
        match = apply_network_verification(
            match,
            bc_dom_odds=bc.first.odds if bc.first else None,
            bti_dom_odds=bti.first.odds if bti.first else None,
            bc_network_odds=self._bc_network_odds,
            bti_network_odds=self._bti_network_odds,
            tolerance=settings.betslip_network_tolerance,
        )

        arbitrage = None
        if match.safe_to_calculate and bc.first and bti.first:
            arbitrage = calculate_arbitrage(
                bc.first,
                bti.first,
                bti_base_stake_krw=settings.default_bti_stake_krw,
                usdt_rate=settings.default_usdt_rate,
            )

        return BetSlipScanResult(bc=bc, bti=bti, match=match, arbitrage=arbitrage)

    def set_network_odds(self, *, bc: float | None = None, bti: float | None = None) -> None:
        if bc is not None:
            self._bc_network_odds = bc
        if bti is not None:
            self._bti_network_odds = bti
