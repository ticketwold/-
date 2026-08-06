from __future__ import annotations

import platform
import subprocess
from pathlib import Path

PROFILE_LOCK_FILES = ("SingletonLock", "SingletonCookie", "SingletonSocket")


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


def read_devtools_active_port(user_data_dir: Path) -> int | None:
    port_file = user_data_dir / "DevToolsActivePort"
    if not port_file.is_file():
        return None
    try:
        first_line = port_file.read_text(encoding="utf-8", errors="ignore").splitlines()[0].strip()
        port = int(first_line)
        return port if port > 0 else None
    except (IndexError, ValueError, OSError):
        return None


def cdp_endpoint_candidates(user_data_dir: Path, extra_urls: tuple[str, ...]) -> list[str]:
    seen: set[str] = set()
    urls: list[str] = []
    port = read_devtools_active_port(user_data_dir)
    if port:
        endpoint = f"http://127.0.0.1:{port}"
        seen.add(endpoint)
        urls.append(endpoint)
    for raw in extra_urls:
        url = raw.strip()
        if url and url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


def validate_profile_directory(user_data_dir: Path, profile_directory: str) -> None:
    profile_path = user_data_dir / profile_directory
    if not profile_path.is_dir():
        raise ChromeProfileError(f"프로필을 찾을 수 없습니다: {profile_path}")


def launch_args_for_mode(mode: str, profile_directory: str) -> list[str]:
    if mode == "existing":
        return [f"--profile-directory={profile_directory}"]
    return []
