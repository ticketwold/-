from __future__ import annotations

from dataclasses import dataclass

from arb_desktop.bridge.connection_manager import ConnectionManager
from arb_desktop.bridge.message_models import BridgeStatus
from arb_desktop.bridge.pairing_server import PairingHTTPServer
from arb_desktop.bridge.pairing_store import PairingStore
from arb_desktop.bridge.session import BridgeSession
from arb_desktop.bridge.websocket_server import BridgeWebSocketServer
from arb_desktop.config import settings


@dataclass
class BridgeRuntime:
    manager: ConnectionManager
    server: BridgeWebSocketServer
    pairing_server: PairingHTTPServer
    pairing_store: PairingStore
    session: BridgeSession

    async def start(self) -> None:
        await self.pairing_server.start()
        await self.server.start()

    async def stop(self) -> None:
        await self.server.stop()
        await self.pairing_server.stop()

    def status(self) -> BridgeStatus:
        return self.manager.status()

    def reset_pairing(self) -> None:
        self.pairing_store.reset_pairing()


def create_bridge_runtime(
    *,
    pairing_store: PairingStore,
    on_status_change=None,
    on_slip_update=None,
    on_slip_rx=None,
    on_debug=None,
) -> BridgeRuntime:
    manager = ConnectionManager(
        token=pairing_store.credential,
        on_status_change=on_status_change,
        on_slip_update=on_slip_update,
        on_slip_rx=on_slip_rx,
        on_debug=on_debug,
    )
    server = BridgeWebSocketServer(
        manager,
        pairing_store,
        host=settings.bridge_host,
        port=settings.bridge_port,
    )
    pairing_server = PairingHTTPServer(
        pairing_store,
        host=settings.bridge_host,
        port=settings.bridge_pair_port,
    )
    session = BridgeSession(manager)
    return BridgeRuntime(
        manager=manager,
        server=server,
        pairing_server=pairing_server,
        pairing_store=pairing_store,
        session=session,
    )


def print_bridge_startup_info(runtime: BridgeRuntime) -> None:
    print("=== arb-desktop Chrome Bridge v1.5.0 ===", flush=True)
    print(f"WebSocket: ws://{settings.bridge_host}:{settings.bridge_port}/", flush=True)
    print(f"Pairing:   http://{settings.bridge_host}:{settings.bridge_pair_port}/pair", flush=True)
    print("", flush=True)
    print("1. chrome-bridge 확장프로그램을 로드하세요 (chrome://extensions)", flush=True)
    print("2. 확장이 자동으로 페어링 및 연결됩니다 (Token 입력 불필요)", flush=True)
    print("3. 평소 Chrome에서 BC.Game / x10x10s 탭을 열어둔 채 사용", flush=True)
    print("", flush=True)
