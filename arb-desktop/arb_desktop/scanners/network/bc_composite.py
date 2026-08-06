from __future__ import annotations

from arb_desktop.models import Matchup
from arb_desktop.scanners.network.bc_cdp_tap import BcCdpNetworkTap
from arb_desktop.scanners.network.sptpub_v4 import SptpubV4Client
from arb_desktop.scanners.tiers import NetworkScanner


class BcCompositeNetworkScanner(NetworkScanner):
    """sptpub v4 HTTP → CDP 캐시 순서."""

    def __init__(self, sptpub: SptpubV4Client, cdp: BcCdpNetworkTap):
        self._sptpub = sptpub
        self._cdp = cdp
        self.tier = sptpub.tier

    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        matchups, msg = await self._sptpub.fetch_matchups()
        if matchups:
            return matchups, msg
        return await self._cdp.fetch_matchups()
