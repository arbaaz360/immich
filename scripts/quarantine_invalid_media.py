#!/usr/bin/env python3
"""Reversibly move validated invalid media outside scanned library roots."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
import shutil
import sys


INVALID = {"corrupt_or_unsupported_image", "corrupt_or_unsupported_video", "immich_decoder_incompatible"}


def destination_for(asset_id: str, source: Path) -> Path:
    if source.drive.upper() == "E:":
        root = Path(r"E:\ImmichInvalidMediaQuarantine")
    else:
        root = Path(r"X:\Immich\invalid-media-quarantine")
    return root / f"{asset_id}_{source.name}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with args.input.open(newline="", encoding="utf-8") as handle:
        rows = [row for row in csv.DictReader(handle) if row["category"] in INVALID]
    moves = []
    for row in rows:
        source = Path(row["host_path"])
        if source.is_file():
            moves.append((row, source, destination_for(row["asset_id"], source)))
    print(f"Files eligible for quarantine: {len(moves):,}")
    if not args.apply:
        return 0
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    with args.manifest.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["asset_id", "category", "source_path", "quarantine_path", "size", "status"])
        for index, (row, source, destination) in enumerate(moves, 1):
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                status = "already_quarantined"
            else:
                size = source.stat().st_size
                shutil.move(str(source), str(destination))
                status = "moved"
                writer.writerow([row["asset_id"], row["category"], source, destination, size, status])
                continue
            writer.writerow([row["asset_id"], row["category"], source, destination, destination.stat().st_size, status])
            if index % 250 == 0:
                print(f"Quarantined {index:,} files", flush=True)
    print(f"Manifest: {args.manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
