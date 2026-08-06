from __future__ import annotations

import secrets
from dataclasses import dataclass

from arb_desktop.bridge.connection_manager import ConnectionManager
from arb_desktop.bridge.message_models import BridgeStatus
from arb_desktop.bridge.session import BridgeSession
from arb_desktop.bridge.websocket_server import BridgeWebSocketServer
from arb_desktop.config import settings


@dataclass
class BridgeRuntime:
    manager: ConnectionManager
    server: BridgeWebSocketServer
    session: BridgeSession

    async def start(self) -> None:
        await self.server.start()

    async def stop(self) -> None:
        await self.server.stop()

    def status(self) -> BridgeStatus:
        return self.manager.status()


def create_bridge_runtime(
    *,
    token: str | None = None,
    on_status_change=None,
    on_slip_update=None,
    on_debug=None,
) -> BridgeRuntime:
    bridge_token = token or settings.bridge_token or secrets.token_urlsafe(24)
    settings.bridge_token = bridge_token
    manager = ConnectionManager(
        token=bridge_token,
        on_status_change=on_status_change,
        on_slip_update=on_slip_update,
        on_debug=on_debug,
    )
    server = BridgeWebSocketServer(
        manager,
        host=settings.bridge_host,
        port=settings.bridge_port,
    )
    session = BridgeSession(manager)
    return BridgeRuntime(manager=manager, server=server, session=session)


def print_bridge_startup_info(runtime: BridgeRuntime) -> None:
    print("=== arb-desktop Chrome Bridge v1.3.1 ===", flush=True)
    print(f"WebSocket: ws://{settings.bridge_host}:{settings.bridge_port}/", flush=True)
    print(f"Token: {runtime.manager.token}", flush=True)
    print("", flush=True)
    print("1. chrome-bridge 확장프로그램을 로드하세요 (chrome://extensions)", flush=True)
    print("2. 확장 storage에 bridgeToken 을 위 Token 값으로 설정", flush=True)
    print("   (개발자 도구 콘솔: chrome.storage.local.set({bridgeToken:'...'}))", flush=True)
    print("3. 평소 Chrome에서 BC.Game / x10x10s 탭을 열어둔 채 연결", flush=True)
    print("", flush=True)
