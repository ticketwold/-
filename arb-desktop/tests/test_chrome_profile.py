from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from arb_desktop.scanners.playwright.chrome_profile import (
    ChromeProfileError,
    cdp_endpoint_candidates,
    find_profile_locks,
    launch_args_for_mode,
    read_devtools_active_port,
    validate_profile_directory,
)


def test_launch_args_existing_profile():
    assert launch_args_for_mode("existing", "Default") == ["--profile-directory=Default"]
    assert launch_args_for_mode("existing", "Profile 1") == ["--profile-directory=Profile 1"]
    assert launch_args_for_mode("dedicated", "Default") == []


def test_find_profile_locks(tmp_path: Path):
    assert find_profile_locks(tmp_path) == []
    (tmp_path / "SingletonLock").write_text("x", encoding="utf-8")
    assert find_profile_locks(tmp_path) == ["SingletonLock"]


def test_read_devtools_active_port(tmp_path: Path):
    assert read_devtools_active_port(tmp_path) is None
    (tmp_path / "DevToolsActivePort").write_text("9333\n/dev/null\n", encoding="utf-8")
    assert read_devtools_active_port(tmp_path) == 9333


def test_cdp_endpoint_candidates(tmp_path: Path):
    (tmp_path / "DevToolsActivePort").write_text("9444\n", encoding="utf-8")
    urls = cdp_endpoint_candidates(tmp_path, ("http://127.0.0.1:9222",))
    assert urls[0] == "http://127.0.0.1:9444"
    assert "http://127.0.0.1:9222" in urls


def test_validate_missing_profile(tmp_path: Path):
    with pytest.raises(ChromeProfileError, match="프로필을 찾을 수 없습니다"):
        validate_profile_directory(tmp_path, "Default")
