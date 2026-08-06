from __future__ import annotations

from arb_desktop.bridge.connection_manager import ConnectionManager
from arb_desktop.bridge.message_models import SlipUpdateMessage, StatusMessage
from arb_desktop.bridge.websocket_server import _token_from_path


def test_token_from_path() -> None:
    assert _token_from_path("/?token=abc123") == "abc123"
    assert _token_from_path("/") == ""


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
    assert "Chrome Bridge: DISCONNECTED" in block
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
