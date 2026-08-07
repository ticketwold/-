from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class CommandResult:
    ok: bool
    command: str = ""
    site: str = ""
    expected: float | None = None
    actual: float | None = None
    reason: str = ""
    error: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


class BridgeCommandBus:
    """Extension command/response over WebSocket."""

    def __init__(self) -> None:
        self._pending: dict[str, asyncio.Future[CommandResult]] = {}
        self._timeout_sec = 5.0

    def resolve(self, payload: dict[str, Any]) -> None:
        request_id = str(payload.get("request_id") or "")
        fut = self._pending.pop(request_id, None)
        if not fut or fut.done():
            return
        result = CommandResult(
            ok=bool(payload.get("ok")),
            command=str(payload.get("command") or ""),
            site=str(payload.get("site") or ""),
            expected=_float_or_none(payload.get("expected")),
            actual=_float_or_none(payload.get("actual")),
            reason=str(payload.get("reason") or payload.get("error") or ""),
            error=str(payload.get("error") or ""),
            raw=payload,
        )
        fut.set_result(result)

    async def send(
        self,
        broadcaster: Any,
        *,
        site: str,
        command: str,
        **params: Any,
    ) -> CommandResult:
        request_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[CommandResult] = loop.create_future()
        self._pending[request_id] = fut
        message = {
            "type": "bridge_command",
            "request_id": request_id,
            "site": site,
            "command": command,
            **params,
        }
        await broadcaster(message)
        try:
            return await asyncio.wait_for(fut, timeout=self._timeout_sec)
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            return CommandResult(ok=False, command=command, site=site, error="command-timeout")
        except Exception as exc:
            self._pending.pop(request_id, None)
            return CommandResult(ok=False, command=command, site=site, error=str(exc))


def _float_or_none(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
