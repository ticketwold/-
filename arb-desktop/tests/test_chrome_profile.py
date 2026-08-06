from __future__ import annotations

from pathlib import Path

import pytest

from arb_desktop.scanners.playwright.chrome_profile import (
    ChromeProfileError,
    launch_args_for_mode,
    validate_profile_directory,
)


def test_launch_args_existing_profile():
    assert launch_args_for_mode("existing", "Profile 3") == ["--profile-directory=Profile 3"]
    assert launch_args_for_mode("existing", "Default") == ["--profile-directory=Default"]
    assert launch_args_for_mode("dedicated", "Profile 3") == []


def test_validate_missing_profile(tmp_path: Path):
    with pytest.raises(ChromeProfileError, match="프로필을 찾을 수 없습니다"):
        validate_profile_directory(tmp_path, "Profile 3")
