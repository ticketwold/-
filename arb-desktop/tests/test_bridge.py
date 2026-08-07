from __future__ import annotations

import asyncio
import json

import pytest

from arb_desktop.bridge.connection_manager import ConnectionManager
from arb_desktop.bridge.message_models import BridgeConnectionState, SlipUpdateMessage, StatusMessage
from arb_desktop.bridge.pairing_store import PairingStore


def test_pairing_store_nonce_flow() -> None:
    store = PairingStore.create()
    ext_id = "abcdefghijklmnop"
    result = store.request_nonce(ext_id)
    assert result is not None
    nonce, _expires = result
    assert store.confirm_nonce(ext_id, nonce) is True
    assert ext_id in store.allowed_extension_ids
    assert store.validate(ext_id, store.credential) is True


def test_pairing_store_rejects_wrong_credential() -> None:
    store = PairingStore.create()
    ext_id = "abcdefghijklmnop"
    result = store.request_nonce(ext_id)
    assert result is not None
    nonce, _ = result
    store.confirm_nonce(ext_id, nonce)
    assert store.validate(ext_id, "wrong-credential") is False


def test_pairing_store_rejects_unknown_extension() -> None:
    store = PairingStore.create()
    ext_a = "aaaaaaaaaaaaaaaa"
    ext_b = "bbbbbbbbbbbbbbbb"
    result = store.request_nonce(ext_a)
    assert result is not None
    nonce, _ = result
    store.confirm_nonce(ext_a, nonce)
    assert store.validate(ext_b, store.credential) is False


def test_pairing_store_reset() -> None:
    store = PairingStore.create()
    ext_id = "abcdefghijklmnop"
    old_cred = store.credential
    result = store.request_nonce(ext_id)
    assert result is not None
    store.confirm_nonce(ext_id, result[0])
    store.reset_pairing()
    assert store.credential != old_cred
    assert store.allowed_extension_ids == []


def test_connection_manager_status() -> None:
    manager = ConnectionManager(token="secret")
    manager.apply_status_message(
        StatusMessage(
            bridge_connected=True,
            bc_tab="found",
            x10_tab="found",
            bc_betslip="active",
            x10_betslip="empty",
        )
    )
    status = manager.status()
    assert status.bridge.value == "CONNECTED"
    assert status.bc_tab.value == "FOUND"
    assert status.x10_tab.value == "FOUND"
    assert status.bc_betslip.value == "ACTIVE"
    assert status.x10_betslip.value == "EMPTY"


def test_connection_manager_auth_failed() -> None:
    manager = ConnectionManager(token="secret")
    manager.set_auth_failed("ext123456789")
    status = manager.status()
    assert status.bridge == BridgeConnectionState.AUTH_FAILED
    assert status.extension_id == "ext123456789"


def test_slip_update_parses_items() -> None:
    manager = ConnectionManager(token="secret")
    read = manager.apply_slip_update(
        SlipUpdateMessage(
            site="bc",
            frame_url="https://bc.game/sports",
            result={
                "ok": True,
                "empty": False,
                "items": [
                    {
                        "event": "Team A vs Team B",
                        "market": "Winner",
                        "selection": "Team A",
                        "odds": 1.95,
                        "status": "active",
                        "stake": 100,
                    }
                ],
            },
        )
    )
    assert read is not None
    assert read.first is not None
    assert read.first.event == "Team A vs Team B"
    assert read.first.odds == 1.95
    assert manager.bc_betslip == "active"


def test_slip_update_prefers_non_empty() -> None:
    manager = ConnectionManager(token="secret")
    empty = manager.apply_slip_update(
        SlipUpdateMessage(
            site="bc",
            result={"ok": False, "empty": True, "items": [], "reason": "no-slip-root"},
        )
    )
    assert empty is not None
    filled = manager.apply_slip_update(
        SlipUpdateMessage(
            site="bc",
            result={
                "ok": True,
                "empty": False,
                "items": [{"event": "A vs B", "selection": "A", "odds": 1.9, "status": "active"}],
            },
        )
    )
    assert filled is not None
    assert manager.bc_slip and manager.bc_slip.first
    assert manager.bc_slip.first.event == "A vs B"
    ignored = manager.apply_slip_update(
        SlipUpdateMessage(
            site="bc",
            result={"ok": False, "empty": True, "items": [], "reason": "no-slip-root"},
        )
    )
    assert ignored is None


def test_status_format_block() -> None:
    manager = ConnectionManager(token="secret")
    block = manager.status().format_block()
    assert "Chrome Bridge: WAITING" in block
    assert "BC.Game tab: NOT FOUND" in block


def test_x10_debug_payload_stored() -> None:
    manager = ConnectionManager(token="secret")
    manager.apply_debug(
        {
            "block": "X10 DEBUG",
            "site": "x10",
            "frame_url": "https://x10x10s.com/sports",
            "document_location": "https://x10x10s.com/sports",
            "frame_depth": 2,
            "document_ready": "complete",
            "body_text_length": 1200,
            "slip_root_found": "NO",
            "reason": "no-slip-root",
            "slip_inner_text": "empty slip text",
            "selector_hits": [
                {"selector": ".bet-slip-item", "match_count": 0, "sample_text": ""},
                {"selector": ".bet-slip", "match_count": 1, "sample_text": "sample"},
            ],
        }
    )
    snap = manager.get_x10_debug()
    assert snap is not None
    assert snap["slip_root_found"] == "NO"
    assert len(snap["selector_hits"]) == 2


def test_x10_slip_update_keeps_selector_hits() -> None:
    manager = ConnectionManager(token="secret")
    read = manager.apply_slip_update(
        SlipUpdateMessage(
            site="x10",
            frame_url="https://x10x10s.com/sports",
            result={
                "ok": False,
                "empty": True,
                "items": [],
                "reason": "no-slip-root",
                "slip_root_found": "NO",
                "slip_inner_text": "debug text",
                "selector_hits": [
                    {"selector": ".bet-slip-item", "match_count": 0, "sample_text": ""},
                ],
            },
        )
    )
    assert read is not None
    assert read.reason == "no-slip-root"
    assert read.raw.get("selector_hits")
    assert read.raw.get("slip_inner_text") == "debug text"


@pytest.mark.asyncio
async def test_pairing_http_flow() -> None:
    from arb_desktop.bridge.pairing_server import PairingHTTPServer

    store = PairingStore.create()
    server = PairingHTTPServer(store, port=0)
    await server.start()
    port = server._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]

    ext_id = "testextensionid01"
    origin = f"chrome-extension://{ext_id}"

    async def post(path: str, body: dict, *, origin_hdr: str = origin) -> tuple[int, dict]:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        payload = json.dumps(body).encode("utf-8")
        req = (
            f"POST {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            f"Origin: {origin_hdr}\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\n"
            "\r\n"
        ).encode("utf-8") + payload
        writer.write(req)
        await writer.drain()
        raw = await reader.read(65536)
        writer.close()
        await writer.wait_closed()
        text = raw.decode("utf-8", errors="ignore")
        status = int(text.split("\r\n")[0].split(" ")[1])
        body_start = text.find("\r\n\r\n")
        data = json.loads(text[body_start + 4 :]) if body_start >= 0 else {}
        return status, data

    status, data = await post("/pair/request", {"extension_id": ext_id})
    assert status == 200
    assert data["ok"] is True
    assert data["nonce"]

    status, data = await post("/pair/confirm", {"extension_id": ext_id, "nonce": data["nonce"]})
    assert status == 200
    assert data["ok"] is True
    assert data["credential"]
    assert store.validate(ext_id, data["credential"])

    status, _ = await post("/pair/request", {"extension_id": ext_id}, origin_hdr="https://evil.com")
    assert status == 403

    await server.stop()


@pytest.mark.asyncio
async def test_websocket_hello_auth() -> None:
    import websockets

    from arb_desktop.bridge.connection_manager import ConnectionManager
    from arb_desktop.bridge.pairing_store import PairingStore
    from arb_desktop.bridge.websocket_server import BridgeWebSocketServer

    store = PairingStore.create()
    ext_id = "testextensionid02"
    nonce_result = store.request_nonce(ext_id)
    assert nonce_result
    store.confirm_nonce(ext_id, nonce_result[0])

    manager = ConnectionManager(token=store.credential)
    server = BridgeWebSocketServer(manager, store, host="127.0.0.1", port=0)
    await server.start()
    port = server._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]

    async with websockets.connect(f"ws://127.0.0.1:{port}/") as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "extension_id": ext_id,
                    "credential": store.credential,
                    "protocol_version": 1,
                }
            )
        )
        ack = json.loads(await ws.recv())
        assert ack["type"] == "hello_ack"
        assert ack["authenticated"] is True
        assert manager.bridge_connected is True

    await server.stop()
    assert manager.bridge_connected is False
