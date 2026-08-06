from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from arb_desktop.scanners.playwright.chrome_profile import (
    CHROME_CLOSE_MESSAGE,
    ChromeProfileError,
    find_profile_locks,
    launch_args_for_mode,
    validate_existing_profile_launch,
)


def test_launch_args_existing_profile():
    assert launch_args_for_mode("existing", "Default") == ["--profile-directory=Default"]
    assert launch_args_for_mode("existing", "Profile 1") == ["--profile-directory=Profile 1"]
    assert launch_args_for_mode("dedicated", "Default") == []


def test_find_profile_locks(tmp_path: Path):
    assert find_profile_locks(tmp_path) == []
    (tmp_path / "SingletonLock").write_text("x", encoding="utf-8")
    assert find_profile_locks(tmp_path) == ["SingletonLock"]


def test_validate_aborts_when_chrome_running(tmp_path: Path):
    (tmp_path / "Default").mkdir()
    with patch(
        "arb_desktop.scanners.playwright.chrome_profile.is_chrome_running",
        return_value=True,
    ):
        with pytest.raises(ChromeProfileError, match=CHROME_CLOSE_MESSAGE):
            validate_existing_profile_launch(tmp_path, "Default")


def test_validate_aborts_on_lock_files(tmp_path: Path):
    (tmp_path / "Default").mkdir()
    (tmp_path / "SingletonCookie").write_text("x", encoding="utf-8")
    with patch(
        "arb_desktop.scanners.playwright.chrome_profile.is_chrome_running",
        return_value=False,
    ):
        with pytest.raises(ChromeProfileError, match="SingletonCookie"):
            validate_existing_profile_launch(tmp_path, "Default")


def test_validate_missing_profile(tmp_path: Path):
    with patch(
        "arb_desktop.scanners.playwright.chrome_profile.is_chrome_running",
        return_value=False,
    ):
        with pytest.raises(ChromeProfileError, match="프로필을 찾을 수 없습니다"):
            validate_existing_profile_launch(tmp_path, "Default")
