from __future__ import annotations

from abc import ABC, abstractmethod

from arb_desktop.models import DetectionTier, ScanSnapshot, SiteId


class SiteScanner(ABC):
    site: SiteId

    @abstractmethod
    async def start(self) -> None:
        ...

    @abstractmethod
    async def stop(self) -> None:
        ...

    @abstractmethod
    async def scan(self) -> ScanSnapshot:
        ...

    @property
    @abstractmethod
    def last_tier(self) -> DetectionTier:
        ...
