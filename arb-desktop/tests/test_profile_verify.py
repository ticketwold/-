from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from arb_desktop.scanners.playwright.chrome_profile import (
    CHROME_CLOSE_MESSAGE,
    find_profile_locks,
    validate_launch_allowed,
)
from arb_desktop.scanners.playwright.profile_verify import (
    _parse_profile_path_from_version_text,
    expected_profile_path,
    launch_args_for_profile,
    paths_match,
)


def test_launch_args_exclude_user_data_dir():
    args = launch_args_for_profile("Default")
    assert "--profile-directory=Default" in args
    assert not any(arg.startswith("--user-data-dir=") for arg in args)


def test_validate_aborts_when_chrome_running(tmp_path: Path):
    user_data = tmp_path / "User Data"
    (user_data / "Default").mkdir(parents=True)
    with patch("arb_desktop.scanners.playwright.chrome_profile.is_chrome_running", return_value=True):
        with pytest.raises(Exception, match=CHROME_CLOSE_MESSAGE):
            validate_launch_allowed(user_data, "Default")


def test_validate_aborts_on_lock_files(tmp_path: Path):
    user_data = tmp_path / "User Data"
    (user_data / "Default").mkdir(parents=True)
    (user_data / "SingletonLock").write_text("x", encoding="utf-8")
    with patch("arb_desktop.scanners.playwright.chrome_profile.is_chrome_running", return_value=False):
        with pytest.raises(Exception, match="SingletonLock"):
            validate_launch_allowed(user_data, "Default")


def test_parse_profile_path_from_version_text():
    text = "Google Chrome\nProfile Path\tC:\\Users\\user\\AppData\\Local\\Google\\Chrome\\User Data\\Default\n"
    assert _parse_profile_path_from_version_text(text).endswith("User Data\\Default")


def test_paths_match_case_insensitive(tmp_path: Path):
    expected = tmp_path / "User Data" / "Default"
    actual = str(expected).upper()
    assert paths_match(expected, actual) is True


def test_expected_profile_path(tmp_path: Path):
    user_data = tmp_path / "User Data"
    assert expected_profile_path(user_data, "Default") == (user_data / "Default").resolve()


def test_find_profile_locks(tmp_path: Path):
    assert find_profile_locks(tmp_path) == []
    (tmp_path / "SingletonCookie").write_text("x", encoding="utf-8")
    assert find_profile_locks(tmp_path) == ["SingletonCookie"]
