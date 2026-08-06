from __future__ import annotations

import platform
import subprocess
from pathlib import Path

PROFILE_LOCK_FILES = ("SingletonLock", "SingletonCookie", "SingletonSocket")

CHROME_CLOSE_MESSAGE = "모든 Chrome 창을 완전히 종료한 뒤 다시 실행하세요."


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


def is_chrome_running() -> bool:
    system = platform.system()
    if system == "Windows":
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq chrome.exe", "/NH"],
            capture_output=True,
            text=True,
            check=False,
        )
        output = (result.stdout or "").lower()
        return "chrome.exe" in output and "no tasks" not in output

    if system == "Darwin":
        for name in ("Google Chrome",):
            result = subprocess.run(["pgrep", "-x", name], capture_output=True, check=False)
            if result.returncode == 0:
                return True
        return False

    for name in ("chrome", "google-chrome", "google-chrome-stable"):
        result = subprocess.run(["pgrep", "-x", name], capture_output=True, check=False)
        if result.returncode == 0:
            return True
    return False


def find_profile_locks(user_data_dir: Path) -> list[str]:
    found: list[str] = []
    for name in PROFILE_LOCK_FILES:
        if (user_data_dir / name).exists():
            found.append(name)
    return found


def validate_existing_profile_launch(user_data_dir: Path, profile_directory: str) -> None:
    """기존 Chrome 프로필 모드 — Chrome 종료·잠금 파일·프로필 존재 확인."""
    if is_chrome_running():
        raise ChromeProfileError(CHROME_CLOSE_MESSAGE)

    locks = find_profile_locks(user_data_dir)
    if locks:
        raise ChromeProfileError(f"{CHROME_CLOSE_MESSAGE} (프로필 잠금: {', '.join(locks)})")

    profile_path = user_data_dir / profile_directory
    if not profile_path.is_dir():
        raise ChromeProfileError(f"프로필을 찾을 수 없습니다: {profile_path}")


def launch_args_for_mode(mode: str, profile_directory: str) -> list[str]:
    if mode == "existing":
        return [f"--profile-directory={profile_directory}"]
    return []
