from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from arb_desktop.scanners.playwright.chrome_profile import (
    default_chrome_user_data_dir,
    is_chrome_running,
)


def test_is_chrome_running_windows_true():
    with patch("platform.system", return_value="Windows"), patch(
        "subprocess.run",
        return_value=type("R", (), {"stdout": "chrome.exe  1234", "returncode": 0})(),
    ):
        assert is_chrome_running() is True


def test_default_chrome_user_data_dir_windows():
    with patch("platform.system", return_value="Windows"), patch(
        "pathlib.Path.home", return_value=Path(r"C:\Users\user")
    ):
        path = default_chrome_user_data_dir()
        assert str(path).replace("\\", "/").endswith("user/AppData/Local/Google/Chrome/User Data")
