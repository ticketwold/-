from __future__ import annotations

import platform
import re
import subprocess
from pathlib import Path


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


def _ports_from_process_command_lines() -> list[int]:
    system = platform.system()
    ports: list[int] = []
    seen: set[int] = set()

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
            for match in re.finditer(r"--remote-debugging-port=(\d+)", text):
                port = int(match.group(1))
                if port not in seen:
                    seen.add(port)
                    ports.append(port)
            if ports:
                break
        return ports

    for name in ("chrome", "google-chrome", "google-chrome-stable", "Google Chrome"):
        try:
            result = subprocess.run(["pgrep", "-ax", name], capture_output=True, text=True, check=False)
        except OSError:
            continue
        for line in (result.stdout or "").splitlines():
            for match in re.finditer(r"--remote-debugging-port=(\d+)", line):
                port = int(match.group(1))
                if port not in seen:
                    seen.add(port)
                    ports.append(port)
    return ports


def discover_cdp_endpoints(user_data_dir: Path, extra_urls: tuple[str, ...]) -> list[str]:
    seen: set[str] = set()
    endpoints: list[str] = []

    def add_endpoint(url: str) -> None:
        if url and url not in seen:
            seen.add(url)
            endpoints.append(url)

    port = read_devtools_active_port(user_data_dir)
    if port:
        add_endpoint(f"http://127.0.0.1:{port}")

    for debug_port in _ports_from_process_command_lines():
        add_endpoint(f"http://127.0.0.1:{debug_port}")

    for raw in extra_urls:
        add_endpoint(raw.strip())

    return endpoints
