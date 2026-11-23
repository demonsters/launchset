"""Builds the app folder, the installer and the AppImage (trimmed)."""

import json
from pathlib import Path


def write_platform_info(target: Path, info: dict) -> None:
    target.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")


def bundle_version(bundle: Path) -> str:
    import plistlib

    with (bundle / "Contents" / "Info.plist").open("rb") as f:
        return str(plistlib.load(f)["CFBundleShortVersionString"])
