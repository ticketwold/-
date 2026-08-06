from __future__ import annotations

import platform
from pathlib import Path


class ChromeProfileError(RuntimeError):
    """Chrome 프로필 실행 전 검증 실패."""


def default_chrome_executable() -> Path:
    system = platform.system()
    if system == "Windows":
        return Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    if system == "Darwin":
        return Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    return Path("/usr/bin/google-chrome")


def default_chrome_user_data_dir() -> Path:
    home = Path.home()
    system = platform.system()
    if system == "Windows":
        return home / "AppData" / "Local" / "Google" / "Chrome" / "User Data"
    if system == "Darwin":
        return home / "Library" / "Application Support" / "Google" / "Chrome"
    return home / ".config" / "google-chrome"


def resolve_chrome_user_data_dir(path: Path | None = None) -> Path:
    if path and str(path).strip():
        return Path(path).expanduser()
    return default_chrome_user_data_dir()


def validate_profile_directory(user_data_dir: Path, profile_directory: str) -> None:
    profile_path = user_data_dir / profile_directory
    if not profile_path.is_dir():
        raise ChromeProfileError(f"프로필을 찾을 수 없습니다: {profile_path}")


def launch_args_for_mode(mode: str, profile_directory: str) -> list[str]:
    if mode == "existing":
        return [f"--profile-directory={profile_directory}"]
    return []
