from __future__ import annotations

from pathlib import Path

import pytest

from arb_desktop.scanners.playwright.profile_verify import (
    _parse_profile_path_from_version_text,
    expected_profile_path,
    forbid_source_user_data_for_launch,
    launch_args_for_automation,
    paths_match,
)


def test_launch_args_include_user_data_and_profile(tmp_path: Path):
    user_data = tmp_path / "arb-chrome-profile"
    args = launch_args_for_automation(user_data, "Default")
    assert f"--user-data-dir={user_data.resolve()}" in args
    assert "--profile-directory=Default" in args


def test_forbid_source_user_data_for_launch():
    automation = Path("/tmp/arb-chrome-profile")
    source = Path("/tmp/Google/Chrome/User Data")
    forbid_source_user_data_for_launch(automation, source)


def test_forbid_when_automation_inside_source(tmp_path: Path):
    source = tmp_path / "User Data"
    automation = source / "arb"
    automation.mkdir(parents=True)
    with pytest.raises(Exception, match="하위 경로"):
        forbid_source_user_data_for_launch(automation, source)


def test_parse_profile_path_from_version_text():
    text = "Google Chrome\nProfile Path\tC:\\Users\\user\\arb-chrome-profile\\Default\n"
    assert _parse_profile_path_from_version_text(text).endswith("arb-chrome-profile\\Default")


def test_paths_match_case_insensitive(tmp_path: Path):
    expected = tmp_path / "arb-chrome-profile" / "Default"
    actual = str(expected).upper()
    assert paths_match(expected, actual) is True


def test_expected_profile_path(tmp_path: Path):
    assert expected_profile_path(tmp_path / "arb-chrome-profile") == (tmp_path / "arb-chrome-profile" / "Default").resolve()
