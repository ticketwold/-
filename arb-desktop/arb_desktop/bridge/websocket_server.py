from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.server import WebSocketServer, WebSocketServerProtocol, serve

from arb_desktop.bridge.connection_manager import ConnectionManager
from arb_desktop.bridge.message_models import SlipUpdateMessage, StatusMessage

logger = logging.getLogger(__name__)


class BridgeWebSocketServer:
    """127.0.0.1 전용 WebSocket 서버 — Chrome Bridge 확장프로그램 연결."""

    def __init__(self, manager: ConnectionManager, *, host: str, port: int) -> None:
        self._manager = manager
        self._host = host
        self._port = port
        self._server: WebSocketServer | None = None
        self._clients: set[WebSocketServerProtocol] = set()

    @property
    def port(self) -> int:
        return self._port

    async def start(self) -> None:
        self._server = await serve(
            self._handler,
            self._host,
            self._port,
            ping_interval=20,
            ping_timeout=20,
        )

    async def stop(self) -> None:
        for client in list(self._clients):
            await client.close()
        self._clients.clear()
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        self._manager.set_bridge_connected(False)

    async def request_status(self) -> None:
        await self._broadcast({"type": "request_status"})

    async def _broadcast(self, message: dict[str, Any]) -> None:
        if not self._clients:
            return
        payload = json.dumps(message)
        await asyncio.gather(
            *[client.send(payload) for client in list(self._clients)],
            return_exceptions=True,
        )

    async def _handler(self, websocket: WebSocketServerProtocol) -> None:
        token = _token_from_path(websocket.path)
        if token != self._manager.token:
            await websocket.send(json.dumps({"type": "auth_fail", "reason": "invalid-token"}))
            await websocket.close(code=4401, reason="invalid token")
            return

        self._clients.add(websocket)
        await websocket.send(json.dumps({"type": "auth_ok"}))
        self._manager.set_bridge_connected(True)

        try:
            async for raw in websocket:
                await self._handle_message(raw)
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)
            if not self._clients:
                self._manager.set_bridge_connected(False)

    async def _handle_message(self, raw: str | bytes) -> None:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return

        msg_type = str(data.get("type") or "")
        if msg_type == "ping":
            return
        if msg_type == "status":
            self._manager.apply_status_message(StatusMessage.model_validate(data))
            return
        if msg_type == "slip_update":
            self._manager.apply_slip_update(SlipUpdateMessage.model_validate(data))
            return
        if msg_type == "bridge_debug":
            self._manager.apply_debug(data)
            return
        if msg_type == "hello":
            await self.request_status()


def _token_from_path(path: str) -> str:
    parsed = urlparse(path or "/")
    values = parse_qs(parsed.query).get("token", [])
    return values[0] if values else ""
