#!/usr/bin/env python3
"""Windows exe 빌드 — PyInstaller.

사용법:
  cd arb-desktop
  pip install pyinstaller
  python build_windows.py

출력:
  dist/ArbDesktop/ArbDesktop.exe
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
CHROME_BRIDGE = WORKSPACE / "chrome-bridge"
DIST = ROOT / "dist" / "ArbDesktop"


def _bundle_icu_dlls(dist_dir: Path) -> None:
    """PyQt6 6.10+ Qt6Core needs ICU DLLs that wheels omit — copy from Windows System32."""
    if not dist_dir.is_dir():
        return
    system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    internal = dist_dir / "_internal"
    target = internal if internal.is_dir() else dist_dir
    for pattern in ("icu.dll", "icuuc.dll", "icuin.dll", "icudt*.dll"):
        for src in system32.glob(pattern):
            dest = target / src.name
            if not dest.exists():
                shutil.copy2(src, dest)
                print(f"Bundled ICU: {src.name}")


def main() -> int:
    if shutil.which("pyinstaller") is None:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller>=6.0"])

    spec_args = [
        "pyinstaller",
        "--noconfirm",
        "--clean",
        "--windowed",
        "--name",
        "ArbDesktop",
        "--distpath",
        str(ROOT / "dist"),
        "--workpath",
        str(ROOT / "build"),
        "--specpath",
        str(ROOT),
        "--add-data",
        f"{CHROME_BRIDGE}{';' if sys.platform == 'win32' else ':'}chrome-bridge",
        "--hidden-import",
        "websockets",
        "--hidden-import",
        "websockets.legacy",
        "--hidden-import",
        "websockets.legacy.server",
        "--hidden-import",
        "PyQt6.QtCore",
        "--hidden-import",
        "PyQt6.QtGui",
        "--hidden-import",
        "PyQt6.QtWidgets",
        "--collect-submodules",
        "websockets",
        "--collect-all",
        "PyQt6",
        "--copy-metadata",
        "PyQt6",
        "--exclude-module",
        "playwright",
        str(ROOT / "arb_desktop" / "main.py"),
    ]

    if sys.platform == "win32":
        spec_args.extend(["--version-file", str(ROOT / "version_info.txt")])

    print("Running:", " ".join(spec_args))
    subprocess.check_call([sys.executable, "-m", "PyInstaller", *spec_args[1:]], cwd=ROOT)

    if sys.platform == "win32":
        _bundle_icu_dlls(DIST)

    # 사용자가 Chrome 확장을 로드할 수 있도록 exe 옆에도 복사
    bridge_dest = DIST / "chrome-bridge"
    if CHROME_BRIDGE.is_dir():
        if bridge_dest.exists():
            shutil.rmtree(bridge_dest)
        shutil.copytree(CHROME_BRIDGE, bridge_dest)

    out_exe = DIST / "ArbDesktop.exe"
    if out_exe.exists():
        print(f"\nBuild OK: {out_exe}")
        print(f"chrome-bridge bundled at: {DIST / 'chrome-bridge'}")
    else:
        print("\nBuild finished — check dist/ folder")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
