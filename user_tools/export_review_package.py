#!/usr/bin/env python3
"""Create a repository ZIP package for ChatGPT code review."""

from __future__ import annotations

import argparse
import datetime as dt
import os
from pathlib import Path
import zipfile


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "output" / "review_packages"

EXCLUDED_DIRS = {
    ".git",
    ".idea",
    ".playwright-cli",
    ".vscode",
    "__pycache__",
    "downloads",
    "exports",
    "node_modules",
    "output",
}

EXCLUDED_FILENAMES = {
    ".DS_Store",
    "Thumbs.db",
}

EXCLUDED_SUFFIXES = {
    ".log",
    ".pyc",
    ".pyo",
    ".zip",
}


def should_include(path: Path) -> bool:
    relative = path.relative_to(REPO_ROOT)
    parts = set(relative.parts)

    if parts & EXCLUDED_DIRS:
        return False
    if path.name in EXCLUDED_FILENAMES:
        return False
    if path.suffix in EXCLUDED_SUFFIXES:
        return False

    return path.is_file()


def iter_package_files() -> list[Path]:
    return sorted(path for path in REPO_ROOT.rglob("*") if should_include(path))


def build_manifest(files: list[Path]) -> str:
    timestamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    lines = [
        "BlockPlan review package",
        f"Created: {timestamp}",
        "",
        "Included files:",
    ]
    lines.extend(f"- {path.relative_to(REPO_ROOT).as_posix()}" for path in files)
    lines.extend(
        [
            "",
            "Excluded by default:",
            "- .git/",
            "- output/",
            "- editor folders",
            "- caches",
            "- logs",
            "- existing zip files",
        ]
    )
    return "\n".join(lines) + "\n"


def create_review_package(output_dir: Path = DEFAULT_OUTPUT_DIR) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_path = output_dir / f"blockplan_review_package_{timestamp}.zip"

    files = iter_package_files()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, path.relative_to(REPO_ROOT).as_posix())
        archive.writestr("REVIEW_PACKAGE_MANIFEST.txt", build_manifest(files))

    return zip_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a ZIP file of this repository for ChatGPT review."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory where the review ZIP will be written.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    zip_path = create_review_package(args.output_dir)
    relative_zip_path = os.path.relpath(zip_path, REPO_ROOT)

    print("Review package created.")
    print(f"ZIP: {relative_zip_path}")
    print("")
    print("Upload this ZIP file to ChatGPT for repository review.")


if __name__ == "__main__":
    main()
