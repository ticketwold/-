from __future__ import annotations

import asyncio

import pytest

from arb_desktop.bridge.command_bus import BridgeCommandBus, CommandResult


@pytest.mark.asyncio
async def test_command_bus_resolve() -> None:
    bus = BridgeCommandBus()
    sent: list[dict] = []

    async def broadcast(msg: dict) -> None:
        sent.append(msg)

    task = asyncio.create_task(bus.send(broadcast, site="bc", command="set_bc_stake", amount_usdt=37.4))
    await asyncio.sleep(0.01)
    assert sent and sent[0]["type"] == "bridge_command"
    rid = sent[0]["request_id"]
    bus.resolve(
        {
            "request_id": rid,
            "ok": True,
            "command": "set_bc_stake",
            "site": "bc",
            "expected": 37.4,
            "actual": 37.4,
        }
    )
    result = await task
    assert result.ok
    assert result.actual == 37.4


@pytest.mark.asyncio
async def test_command_bus_timeout() -> None:
    bus = BridgeCommandBus()
    bus._timeout_sec = 0.05

    async def broadcast(_msg: dict) -> None:
        pass

    result = await bus.send(broadcast, site="bc", command="read_bc_stake")
    assert not result.ok
    assert result.error == "command-timeout"
