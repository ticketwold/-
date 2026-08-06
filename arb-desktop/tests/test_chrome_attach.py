from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from arb_desktop.scanners.playwright.chrome_attach import (
    discover_cdp_endpoints,
    is_chrome_running,
    read_devtools_active_port,
)


def test_read_devtools_active_port(tmp_path: Path):
    assert read_devtools_active_port(tmp_path) is None
    (tmp_path / "DevToolsActivePort").write_text("9333\n", encoding="utf-8")
    assert read_devtools_active_port(tmp_path) == 9333


def test_discover_cdp_endpoints(tmp_path: Path):
    (tmp_path / "DevToolsActivePort").write_text("9444\n", encoding="utf-8")
    with patch(
        "arb_desktop.scanners.playwright.chrome_attach._ports_from_process_command_lines",
        return_value=[9222],
    ):
        urls = discover_cdp_endpoints(tmp_path, ("http://127.0.0.1:9229",))
    assert urls[0] == "http://127.0.0.1:9444"
    assert "http://127.0.0.1:9222" in urls
    assert "http://127.0.0.1:9229" in urls


def test_is_chrome_running_windows_true():
    with patch("platform.system", return_value="Windows"), patch(
        "subprocess.run",
        return_value=type("R", (), {"stdout": "chrome.exe  1234", "returncode": 0})(),
    ):
        assert is_chrome_running() is True
