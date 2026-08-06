from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from arb_desktop.scanners.playwright.session import BrowserSession


@pytest.mark.asyncio
async def test_launch_persistent_context_timeout_exits(capsys) -> None:
    session = BrowserSession()

    async def slow_launch(*_args, **_kwargs):
        await asyncio.sleep(60)
        return MagicMock()

    mock_pw = MagicMock()
    mock_pw.chromium.launch_persistent_context = slow_launch
    mock_pw.stop = AsyncMock()

    with (
        patch("arb_desktop.scanners.playwright.session.async_playwright") as mock_ap,
        patch("arb_desktop.scanners.playwright.session.validate_launch_allowed"),
        patch("arb_desktop.scanners.playwright.session.LAUNCH_PERSISTENT_CONTEXT_TIMEOUT_SEC", 0.1),
    ):
        mock_ap.return_value.start = AsyncMock(return_value=mock_pw)
        with pytest.raises(SystemExit) as exc:
            await session.start()

    assert exc.value.code == 1
    output = capsys.readouterr().out
    assert "[DEBUG] before launch_persistent_context" in output
    assert "[ERROR] launch_persistent_context timeout" in output
    assert "[DEBUG] after launch_persistent_context" not in output
