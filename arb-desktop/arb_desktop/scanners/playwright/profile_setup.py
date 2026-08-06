from __future__ import annotations

import json
import platform
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from arb_desktop.scanners.playwright.chrome_profile import ChromeProfileError, is_chrome_running

SETUP_MARKER = ".arb-setup-complete.json"
PROFILE_SUBDIR = "Default"

EXCLUDE_DIRS = frozenset(
    {
        "Cache",
        "Code Cache",
        "GPUCache",
        "DawnCache",
        "Crashpad",
        "GrShaderCache",
        "ShaderCache",
        "Media Cache",
        "Service Worker",
        "BrowserMetrics",
        "optimization_guide_hint_cache_store",
    }
)

EXCLUDE_FILES = frozenset(
    {
        "SingletonLock",
        "SingletonCookie",
        "SingletonSocket",
        "LOCK",
        "LOG",
        "LOG.old",
    }
)


@dataclass(slots=True)
class ProfileSetupResult:
    copied_files: int
    copied_dirs: int
    skipped: int
    destination: Path
    source_profile: Path
    already_configured: bool = False


def automation_profile_ready(automation_dir: Path) -> bool:
    marker = automation_dir / SETUP_MARKER
    profile_dir = automation_dir / PROFILE_SUBDIR
    return marker.is_file() and profile_dir.is_dir()


def _should_skip(name: str) -> bool:
    if name in EXCLUDE_FILES or name in EXCLUDE_DIRS:
        return True
    if name.startswith("Singleton"):
        return True
    return False


def _copy_profile_item(src: Path, dst: Path) -> tuple[int, int, int]:
    files = dirs = skipped = 0
    if src.is_dir():
        if _should_skip(src.name):
            return 0, 0, 1
        dst.mkdir(parents=True, exist_ok=True)
        for child in src.iterdir():
            cf, cd, cs = _copy_profile_item(child, dst / child.name)
            files += cf
            dirs += cd
            skipped += cs
        return files, dirs + 1, skipped

    if _should_skip(src.name):
        return 0, 0, 1

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return 1, 0, 0


def setup_automation_profile(
    *,
    source_user_data: Path,
    source_profile_name: str,
    automation_dir: Path,
    force: bool = False,
) -> ProfileSetupResult:
    if is_chrome_running():
        raise ChromeProfileError("Chrome을 완전히 종료한 뒤 --setup-profile을 실행하세요.")

    source_profile = source_user_data / source_profile_name
    if not source_profile.is_dir():
        raise ChromeProfileError(f"원본 프로필을 찾을 수 없습니다: {source_profile}")

    if automation_profile_ready(automation_dir) and not force:
        return ProfileSetupResult(
            copied_files=0,
            copied_dirs=0,
            skipped=0,
            destination=automation_dir,
            source_profile=source_profile,
            already_configured=True,
        )

    dest_profile = automation_dir / PROFILE_SUBDIR
    if dest_profile.exists() and force:
        shutil.rmtree(dest_profile, ignore_errors=True)

    dest_profile.mkdir(parents=True, exist_ok=True)

    copied_files = copied_dirs = skipped = 0
    try:
        for item in source_profile.iterdir():
            cf, cd, cs = _copy_profile_item(item, dest_profile / item.name)
            copied_files += cf
            copied_dirs += cd
            skipped += cs
    except Exception as exc:
        raise ChromeProfileError(f"프로필 복제 실패 (원본은 변경하지 않음): {exc}") from exc

    marker = {
        "source_user_data": str(source_user_data),
        "source_profile": source_profile_name,
        "destination": str(automation_dir),
        "copied_files": copied_files,
        "copied_dirs": copied_dirs,
        "skipped": skipped,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (automation_dir / SETUP_MARKER).write_text(
        json.dumps(marker, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return ProfileSetupResult(
        copied_files=copied_files,
        copied_dirs=copied_dirs,
        skipped=skipped,
        destination=automation_dir,
        source_profile=source_profile,
    )


def ensure_automation_profile_ready(automation_dir: Path) -> None:
    if not automation_profile_ready(automation_dir):
        raise ChromeProfileError(
            "자동화 프로필이 준비되지 않았습니다. "
            '먼저 실행하세요: python scripts/run_auto_betslip.py --setup-profile --source-profile "Profile 3"'
        )
