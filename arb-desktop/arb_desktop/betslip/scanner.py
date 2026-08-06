from __future__ import annotations

from arb_desktop.betslip.matcher import apply_network_verification, calculate_arbitrage, check_slip_pair
from arb_desktop.betslip.models import BetSlipScanResult
from arb_desktop.config import settings

if False:  # TYPE_CHECKING-style import guard without circular import at runtime
    from arb_desktop.bridge.connection_manager import ConnectionManager
    from arb_desktop.bridge.session import BridgeSession


class BetSlipScanner:
    """BetSlip-first 메인 스캐너 — Bridge 또는 (비활성) Playwright DOM."""

    def __init__(
        self,
        session: "BridgeSession | None" = None,
        *,
        manager: "ConnectionManager | None" = None,
    ) -> None:
        self._session = session
        self._manager = manager or (session.manager if session else None)
        self._bc_network_odds: float | None = None
        self._bti_network_odds: float | None = None

    async def scan(self, *, debug: bool = False, cart_wait_sec: float = 30.0) -> BetSlipScanResult:
        if self._manager:
            bc = self._manager.get_bc_read()
            bti = self._manager.get_bti_read()
        else:
            from arb_desktop.betslip.readers.dom import read_bc_betslip, read_bti_betslip
            from arb_desktop.scanners.playwright.session import BrowserSession

            if not isinstance(self._session, BrowserSession):
                raise RuntimeError("Bridge 연결이 없습니다. Chrome Bridge 확장프로그램을 연결하세요.")
            bc = await read_bc_betslip(self._session.bc_page, debug=debug)
            bti = await read_bti_betslip(self._session.bti_page, debug=debug, wait_sec=cart_wait_sec)

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
