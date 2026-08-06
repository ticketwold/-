from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from arb_desktop.betslip.execution_models import LocatorCacheEntry


@dataclass
class StableLocatorCache:
    """DOM hash 기반 locator 캐시 — hash 변경 시 폐기."""

    max_retries: int = 3
    _entries: dict[str, LocatorCacheEntry] = field(default_factory=dict)

    def get(self, site: str) -> LocatorCacheEntry | None:
        return self._entries.get(site)

    def put(self, entry: LocatorCacheEntry) -> None:
        self._entries[entry.site] = entry

    def invalidate(self, site: str | None = None) -> None:
        if site:
            self._entries.pop(site, None)
        else:
            self._entries.clear()

    def should_refresh(self, site: str, dom_hash: str) -> bool:
        entry = self._entries.get(site)
        if not entry:
            return True
        return entry.dom_hash != dom_hash

    @staticmethod
    def hash_dom(content: str) -> str:
        return hashlib.sha256(content.encode("utf-8", errors="ignore")).hexdigest()[:16]
