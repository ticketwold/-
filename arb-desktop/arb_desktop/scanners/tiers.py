from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from arb_desktop.models import DetectionTier, Matchup


class NetworkScanner(ABC):
    tier: DetectionTier

    @abstractmethod
    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        """Return (matchups, diagnostic message)."""
        ...


class PlaywrightScanner(ABC):
    tier = DetectionTier.PLAYWRIGHT_DOM

    @abstractmethod
    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        ...


class OcrScanner(ABC):
    tier = DetectionTier.OCR

    @abstractmethod
    async def fetch_matchups(self) -> tuple[list[Matchup], str]:
        ...
