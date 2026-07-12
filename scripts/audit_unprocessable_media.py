#!/usr/bin/env python3
"""Classify active assets that still lack a usable thumbnail.

This is read-only. Original media is opened only for validation and is never changed.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import subprocess
import sys

from PIL import Image


def psql_rows(sql: str):
    command = ["docker", "exec", "-i", "immich-db", "psql", "-U", "postgres", "-d", "immich", "-qAt", "-c", sql]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
    assert process.stdout is not None
    yield from csv.reader(process.stdout)
    if process.wait():
        raise RuntimeError("psql export failed")


def host_path(container_path: str) -> Path | None:
    normalized = container_path.replace("\\", "/")
    mappings = (
        ("/data/library/", Path(r"X:\Immich\uploads\library")),
        ("/external/", Path(r"X:\Immich\uploads\library")),
        ("/data/", Path(r"X:\Immich\uploads")),
        ("/mnt/e/", Path("E:\\")),
    )
    for prefix, root in mappings:
        if normalized.startswith(prefix):
            relative = normalized[len(prefix):].replace("/", os.sep)
            return root / relative
    return None


def validate_image(path: Path) -> tuple[str, str, str]:
    try:
        with Image.open(path) as image:
            detected_format = image.format or ""
            image.verify()
        with Image.open(path) as image:
            image.load()
        return "decodable_image", detected_format, ""
    except Exception as exc:
        return "corrupt_or_unsupported_image", "", str(exc)


def validate_video(path: Path) -> tuple[str, str, str]:
    command = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height", "-of", "json", str(path),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        return "video_not_validated", "", "ffprobe is not installed"
    except subprocess.TimeoutExpired:
        return "corrupt_or_unsupported_video", "", "ffprobe timed out"
    if result.returncode:
        return "corrupt_or_unsupported_video", "", result.stderr.strip()
    try:
        streams = json.loads(result.stdout).get("streams", [])
    except json.JSONDecodeError:
        streams = []
    if not streams:
        return "corrupt_or_unsupported_video", "", "no video stream"
    return "decodable_video", streams[0].get("codec_name", ""), ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    sql = '''copy (
      select a.id::text, a.type, a."originalPath", a."originalFileName",
             case when js."assetId" is null then '0' else '1' end,
             case when ae."assetId" is null then '0' else '1' end,
             a."isOffline"::text
      from asset a
      left join asset_job_status js on js."assetId" = a.id
      left join asset_exif ae on ae."assetId" = a.id
      where a."deletedAt" is null and a.status = 'active' and a.visibility <> 'hidden'
        and (a.thumbhash is null or not exists (
          select 1 from asset_file af
          where af."assetId" = a.id and af.type = 'thumbnail' and af."isEdited" = false
        ))
      order by a.id
    ) to stdout with csv'''

    counts: dict[str, int] = {}
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([
            "asset_id", "asset_type", "database_path", "host_path", "original_file_name",
            "category", "detected_format", "has_job_status", "has_exif", "is_offline", "detail",
        ])
        for index, row in enumerate(psql_rows(sql), 1):
            asset_id, asset_type, database_path, original_name, has_status, has_exif, is_offline = row
            path = host_path(database_path)
            if path is None:
                category, detected, detail = "unmapped_path", "", "No host mapping"
            elif not path.is_file():
                category, detected, detail = "missing_original", "", "File does not exist"
            elif asset_type == "IMAGE":
                category, detected, detail = validate_image(path)
            elif asset_type == "VIDEO":
                category, detected, detail = validate_video(path)
            else:
                category, detected, detail = "unsupported_asset_type", "", asset_type
            if category.startswith("decodable") and has_exif == "0":
                category = "missing_metadata"
            counts[category] = counts.get(category, 0) + 1
            writer.writerow([
                asset_id, asset_type, database_path, str(path or ""), original_name,
                category, detected, has_status, has_exif, is_offline, detail,
            ])
            if index % 250 == 0:
                print(f"Checked {index:,} assets", flush=True)
    print(json.dumps(counts, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
