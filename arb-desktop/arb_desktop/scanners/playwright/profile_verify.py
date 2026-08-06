from __future__ import annotations

import platform
import re
import subprocess
from pathlib import Path

from playwright.async_api import BrowserContext, Page

from arb_desktop.scanners.playwright.chrome_profile import ChromeProfileError

DEFAULT_PROFILE_SUBDIR = "Default"


def expected_profile_path(user_data_dir: Path, profile_subdir: str = DEFAULT_PROFILE_SUBDIR) -> Path:
    return Path(user_data_dir).expanduser().resolve() / profile_subdir


def launch_args_for_profile(profile_subdir: str = DEFAULT_PROFILE_SUBDIR) -> list[str]:
    return [
        f"--profile-directory={profile_subdir}",
        "--no-first-run",
        "--no-default-browser-check",
    ]


def _normalize_path(value: str) -> str:
    return str(Path(value).expanduser().resolve()).lower()


def paths_match(expected: Path, actual: str) -> bool:
    if not actual.strip():
        return False
    return _normalize_path(str(expected)) == _normalize_path(actual)


def _parse_profile_path_from_version_text(text: str) -> str:
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        lowered = line.lower()
        if lowered.startswith("profile path") or line.startswith("프로필 경로"):
            if "\t" in line:
                return line.split("\t", 1)[1].strip()
            match = re.search(r"(?:Profile Path|프로필 경로)\s*:?\s*(.+)$", line, re.I)
            if match:
                return match.group(1).strip()
    return ""


async def read_profile_path_from_version_page(page: Page) -> str:
    await page.goto("chrome://version/", wait_until="domcontentloaded", timeout=20_000)
    text = await page.evaluate("() => document.body ? document.body.innerText : ''")
    profile = _parse_profile_path_from_version_text(str(text))
    if profile:
        return profile
    raise ChromeProfileError("chrome://version에서 Profile Path를 읽지 못했습니다.")


def read_profile_path_from_processes(user_data_dir: Path, profile_subdir: str = DEFAULT_PROFILE_SUBDIR) -> str:
    resolved_user_data = Path(user_data_dir).expanduser().resolve()
    command_lines = _collect_chrome_command_lines()
    for cmd in command_lines:
        user_data_match = re.search(r'--user-data-dir=(?:"([^"]+)"|([^\s"]+))', cmd, re.I)
        if not user_data_match:
            continue
        cmd_user_data = Path((user_data_match.group(1) or user_data_match.group(2) or "").strip()).resolve()
        if cmd_user_data != resolved_user_data:
            continue
        profile_match = re.search(r'--profile-directory=(?:"([^"]+)"|([^\s"]+))', cmd, re.I)
        profile_name = (profile_match.group(1) or profile_match.group(2) or profile_subdir).strip()
        return str((cmd_user_data / profile_name).resolve())
    return ""


def _collect_chrome_command_lines() -> list[str]:
    system = platform.system()
    lines: list[str] = []

    if system == "Windows":
        commands = [
            ["wmic", "process", "where", "name='chrome.exe'", "get", "CommandLine", "/FORMAT:LIST"],
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\").CommandLine",
            ],
        ]
        for cmd in commands:
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=8)
            except (OSError, subprocess.TimeoutExpired):
                continue
            text = result.stdout or ""
            if "CommandLine=" in text:
                for part in text.split("CommandLine="):
                    part = part.strip()
                    if part:
                        lines.append(part)
            else:
                lines.extend([ln.strip() for ln in text.splitlines() if ln.strip()])
            if lines:
                break
        return lines

    for name in ("chrome", "google-chrome", "google-chrome-stable", "Google Chrome"):
        try:
            result = subprocess.run(["pgrep", "-ax", name], capture_output=True, text=True, check=False)
        except OSError:
            continue
        lines.extend([ln.strip() for ln in (result.stdout or "").splitlines() if ln.strip()])
    return lines


async def detect_actual_profile_path(
    context: BrowserContext,
    *,
    user_data_dir: Path,
    profile_subdir: str = DEFAULT_PROFILE_SUBDIR,
) -> str:
    page = context.pages[0] if context.pages else await context.new_page()
    try:
        return await read_profile_path_from_version_page(page)
    except Exception:
        from_process = read_profile_path_from_processes(user_data_dir, profile_subdir)
        if from_process:
            return from_process
        raise


def verify_profile_path(
    *,
    expected: Path,
    actual: str,
    requested_user_data_dir: Path,
    requested_profile: str,
) -> None:
    print("[PROFILE]", flush=True)
    print(f"requested_user_data_dir: {requested_user_data_dir}", flush=True)
    print(f"requested_profile: {requested_profile}", flush=True)
    print(f"actual_profile_path: {actual or '-'}", flush=True)

    if paths_match(expected, actual):
        return

    print("[PROFILE ERROR]", flush=True)
    print(f"expected: {expected}", flush=True)
    print(f"actual: {actual or '-'}", flush=True)
    raise ChromeProfileError("프로필 경로 검증 실패")
