from __future__ import annotations

import pytest

from arb_desktop.scanners.playwright.session import BrowserSession


@pytest.mark.asyncio
async def test_browser_session_disabled() -> None:
    session = BrowserSession()
    with pytest.raises(RuntimeError, match="Chrome Bridge"):
        await session.start()
