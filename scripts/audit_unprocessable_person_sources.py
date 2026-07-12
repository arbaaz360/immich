#!/usr/bin/env python3
"""Classify the source asset for people whose thumbnail is still missing."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
import sys

from audit_unprocessable_media import host_path, psql_rows, validate_image, validate_video


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sql = '''copy (
      select distinct a.id::text, a.type, a."originalPath", a."originalFileName",
             case when js."assetId" is null then '0' else '1' end,
             case when ae."assetId" is null then '0' else '1' end,
             a."isOffline"::text
      from person p
      join asset_face f on f.id = p."faceAssetId"
      join asset a on a.id = f."assetId"
      left join asset_job_status js on js."assetId" = a.id
      left join asset_exif ae on ae."assetId" = a.id
      where p."thumbnailPath" = '' and p."faceAssetId" is not null
    ) to stdout with csv'''
    counts: dict[str, int] = {}
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["asset_id", "asset_type", "database_path", "host_path", "original_file_name", "category", "detected_format", "has_job_status", "has_exif", "is_offline", "detail"])
        for asset_id, asset_type, database_path, original_name, has_status, has_exif, is_offline in psql_rows(sql):
            path = host_path(database_path)
            if path is None:
                category, detected, detail = "unmapped_path", "", "No host mapping"
            elif not path.is_file():
                category, detected, detail = "missing_original", "", "File does not exist"
            elif asset_type == "IMAGE":
                category, detected, detail = validate_image(path)
            else:
                category, detected, detail = validate_video(path)
            counts[category] = counts.get(category, 0) + 1
            writer.writerow([asset_id, asset_type, database_path, str(path or ""), original_name, category, detected, has_status, has_exif, is_offline, detail])
    print(counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
