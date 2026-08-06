from __future__ import annotations

import platform
import subprocess
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


def default_automation_profile_dir() -> Path:
    return (Path.home() / "arb-chrome-profile").resolve()


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
        result = subprocess.run(["pgrep", "-x", "Google Chrome"], capture_output=True, check=False)
        return result.returncode == 0

    for name in ("chrome", "google-chrome", "google-chrome-stable"):
        result = subprocess.run(["pgrep", "-x", name], capture_output=True, check=False)
        if result.returncode == 0:
            return True
    return False
