from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from arb_desktop.scanners.playwright.profile_setup import (
    EXCLUDE_DIRS,
    EXCLUDE_FILES,
    automation_profile_ready,
    setup_automation_profile,
)


def test_automation_profile_ready(tmp_path: Path):
    assert automation_profile_ready(tmp_path) is False
    (tmp_path / "Default").mkdir()
    (tmp_path / ".arb-setup-complete.json").write_text("{}", encoding="utf-8")
    assert automation_profile_ready(tmp_path) is True


def test_setup_skips_cache_and_lock_files(tmp_path: Path):
    source_user = tmp_path / "User Data"
    source_profile = source_user / "Profile 3"
    source_profile.mkdir(parents=True)
    (source_profile / "Cookies").write_text("cookie-data", encoding="utf-8")
    (source_profile / "Preferences").write_text("{}", encoding="utf-8")
    (source_profile / "SingletonLock").write_text("lock", encoding="utf-8")
    cache_dir = source_profile / "Cache"
    cache_dir.mkdir()
    (cache_dir / "data").write_text("x", encoding="utf-8")

    dest = tmp_path / "arb-chrome-profile"

    with patch("arb_desktop.scanners.playwright.profile_setup.is_chrome_running", return_value=False):
        result = setup_automation_profile(
            source_user_data=source_user,
            source_profile_name="Profile 3",
            automation_dir=dest,
        )

    assert result.copied_files >= 2
    assert (dest / "Default" / "Cookies").is_file()
    assert not (dest / "Default" / "SingletonLock").exists()
    assert not (dest / "Default" / "Cache").exists()
    assert EXCLUDE_FILES & {"SingletonLock"}
    assert "Cache" in EXCLUDE_DIRS


def test_setup_aborts_when_chrome_running(tmp_path: Path):
    source_user = tmp_path / "User Data"
    (source_user / "Profile 3").mkdir(parents=True)
    with patch("arb_desktop.scanners.playwright.profile_setup.is_chrome_running", return_value=True):
        with pytest.raises(Exception, match="Chrome을 완전히 종료"):
            setup_automation_profile(
                source_user_data=source_user,
                source_profile_name="Profile 3",
                automation_dir=tmp_path / "arb",
            )


def test_setup_already_configured_skips(tmp_path: Path):
    dest = tmp_path / "arb"
    (dest / "Default").mkdir(parents=True)
    (dest / ".arb-setup-complete.json").write_text("{}", encoding="utf-8")
    source_user = tmp_path / "User Data"
    (source_user / "Profile 3").mkdir(parents=True)

    with patch("arb_desktop.scanners.playwright.profile_setup.is_chrome_running", return_value=False):
        result = setup_automation_profile(
            source_user_data=source_user,
            source_profile_name="Profile 3",
            automation_dir=dest,
        )
    assert result.already_configured is True
