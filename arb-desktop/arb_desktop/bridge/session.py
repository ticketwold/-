from __future__ import annotations

from arb_desktop.bridge.connection_manager import ConnectionManager


class BridgeSession:
    """기존 Chrome 탭 + Bridge 확장프로그램 연결 세션 (Playwright 미사용)."""

    def __init__(self, manager: ConnectionManager) -> None:
        self._manager = manager

    @property
    def manager(self) -> ConnectionManager:
        return self._manager

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    def is_connected(self) -> bool:
        return self._manager.bridge_connected
