from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import websockets
from websockets.server import WebSocketServer, WebSocketServerProtocol, serve

from arb_desktop.bridge.command_bus import BridgeCommandBus
from arb_desktop.bridge.connection_manager import ConnectionManager
from arb_desktop.bridge.message_models import SlipUpdateMessage, StatusMessage
from arb_desktop.bridge.pairing_store import PairingStore

logger = logging.getLogger(__name__)

HELLO_TIMEOUT_SEC = 10.0
PROTOCOL_VERSION = 1


class BridgeWebSocketServer:
    """127.0.0.1 전용 WebSocket 서버 — Chrome Bridge 확장프로그램 연결."""

    def __init__(
        self,
        manager: ConnectionManager,
        pairing_store: PairingStore,
        *,
        host: str,
        port: int,
    ) -> None:
        self._manager = manager
        self._pairing_store = pairing_store
        self._host = host
        self._port = port
        self._server: WebSocketServer | None = None
        self._clients: set[WebSocketServerProtocol] = set()
        self.command_bus = BridgeCommandBus()

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

    async def request_slip_scan(self, site: str) -> None:
        await self._broadcast({"type": "request_slip_scan", "site": site})

    async def send_command(self, site: str, command: str, **params: Any) -> Any:
        return await self.command_bus.send(self._broadcast, site=site, command=command, **params)

    async def _broadcast(self, message: dict[str, Any]) -> None:
        if not self._clients:
            return
        payload = json.dumps(message)
        await asyncio.gather(
            *[client.send(payload) for client in list(self._clients)],
            return_exceptions=True,
        )

    async def _handler(self, websocket: WebSocketServerProtocol) -> None:
        authenticated = False
        extension_id = ""
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=HELLO_TIMEOUT_SEC)
            data = json.loads(raw)
            if str(data.get("type") or "") != "hello":
                await self._auth_fail(websocket, "expected-hello")
                return

            extension_id = str(data.get("extension_id") or "")
            credential = str(data.get("credential") or "")
            version = int(data.get("protocol_version") or 0)
            if version != PROTOCOL_VERSION:
                await self._auth_fail(websocket, "protocol-mismatch")
                return

            if not self._pairing_store.validate(extension_id, credential):
                logger.warning(
                    "auth failed extension_id=%s…%s",
                    extension_id[:6],
                    extension_id[-4:] if extension_id else "",
                )
                self._manager.set_auth_failed(extension_id or None)
                await self._auth_fail(websocket, "invalid-credential")
                return

            self._clients.add(websocket)
            authenticated = True
            await websocket.send(json.dumps({"type": "hello_ack", "authenticated": True}))
            self._manager.set_bridge_connected(True, extension_id=extension_id)

            async for message_raw in websocket:
                await self._handle_message(message_raw)
        except asyncio.TimeoutError:
            await self._auth_fail(websocket, "hello-timeout")
        except websockets.ConnectionClosed:
            pass
        except json.JSONDecodeError:
            await self._auth_fail(websocket, "invalid-json")
        finally:
            if authenticated:
                self._clients.discard(websocket)
                if not self._clients:
                    self._manager.set_bridge_connected(False)

    async def _auth_fail(self, websocket: WebSocketServerProtocol, reason: str) -> None:
        try:
            await websocket.send(json.dumps({"type": "auth_fail", "reason": reason}))
        except Exception:
            pass
        await websocket.close(code=4401, reason="authentication failed")

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
            item = (data.get("result") or {}).get("items") or []
            first = item[0] if item else {}
            logger.info(
                "[PYTHON RX] type=%s site=%s tab_id=%s frame_id=%s frame_url=%s status=%s odds=%s slip_count=%s",
                msg_type,
                data.get("site"),
                data.get("tab_id"),
                data.get("frame_id"),
                data.get("frame_url"),
                first.get("status") or (data.get("result") or {}).get("parsed_status"),
                first.get("odds") or (data.get("result") or {}).get("extracted_odds"),
                (data.get("result") or {}).get("slip_count"),
            )
            self._manager.apply_slip_update(SlipUpdateMessage.model_validate(data))
            return
        if msg_type == "bridge_debug":
            logger.info(
                "[PYTHON RX] type=%s site=%s block=%s frame_url=%s",
                msg_type,
                data.get("site"),
                data.get("block"),
                data.get("frame_url"),
            )
            self._manager.apply_debug(data)
            self._maybe_save_dom_snapshot(data)
            return
        if msg_type == "stake_sync_result":
            self._manager.apply_debug(
                {
                    **data,
                    "block": "BC STAKE SYNC OK" if data.get("success") else "BC STAKE SYNC FAILED",
                }
            )
            return
        if msg_type == "stake_input_changed":
            self._manager.apply_stake_input_changed(data)
            return
        if msg_type == "command_result":
            self.command_bus.resolve(data)
            return
        if msg_type == "hello":
            await self.request_status()

    async def _maybe_save_dom_snapshot(self, data: dict[str, Any]) -> None:
        snapshot = data.get("dom_snapshot")
        filename = data.get("dom_snapshot_file")
        if not snapshot or not filename:
            return
        try:
            from pathlib import Path

            log_dir = Path.home() / ".config" / "arb-desktop" / "logs"
            if hasattr(self._manager, "logs_dir"):
                log_dir = getattr(self._manager, "logs_dir", log_dir)
            log_dir.mkdir(parents=True, exist_ok=True)
            path = log_dir / str(filename)
            path.write_text(str(snapshot), encoding="utf-8")
            logger.info("[DOM SNAPSHOT] saved %s bytes=%s", path, len(str(snapshot)))
        except OSError as exc:
            logger.warning("[DOM SNAPSHOT] save failed: %s", exc)
