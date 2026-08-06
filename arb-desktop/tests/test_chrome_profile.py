from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from arb_desktop.scanners.playwright.chrome_profile import is_chrome_running


def test_is_chrome_running_windows_true():
    with patch("platform.system", return_value="Windows"), patch(
        "subprocess.run",
        return_value=type("R", (), {"stdout": "chrome.exe  1234", "returncode": 0})(),
    ):
        assert is_chrome_running() is True


def test_default_automation_profile_dir():
    from arb_desktop.scanners.playwright.chrome_profile import default_automation_profile_dir

    assert default_automation_profile_dir() == Path.home() / "arb-chrome-profile"
