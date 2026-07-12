#!/usr/bin/env python3
"""Mark proven-bad originals offline and repair dependent cover/person state."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
import subprocess
import sys


INVALID_CATEGORIES = {
    "missing_original",
    "corrupt_or_unsupported_image",
    "corrupt_or_unsupported_video",
    "unsupported_asset_type",
    "unmapped_path",
    "immich_decoder_incompatible",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    with args.input.open(newline="", encoding="utf-8") as handle:
        rows = [row for row in csv.DictReader(handle) if row["category"] in INVALID_CATEGORIES]
    print(f"Validated invalid assets: {len(rows):,}")
    if not args.apply:
        print("Audit only; pass --apply to update Immich.")
        return 0

    copy_rows = "".join(
        f'{row["asset_id"]},"{row["category"]}","{row["database_path"].replace(chr(34), chr(34) * 2)}"\n'
        for row in rows
    )
    sql = r"""
\set ON_ERROR_STOP on
begin;
create table if not exists invalid_media_repair (
  "assetId" uuid primary key references asset(id) on delete cascade,
  category text not null,
  "originalPath" text not null,
  "recordedAt" timestamptz not null default now()
);
create table if not exists invalid_media_path (
  "originalPath" text primary key,
  category text not null,
  "recordedAt" timestamptz not null default now()
);
create temporary table repair_input ("assetId" uuid primary key, category text, "originalPath" text);
copy repair_input ("assetId", category, "originalPath") from stdin with csv;
{copy_rows}\.
insert into invalid_media_repair ("assetId", category, "originalPath")
select r."assetId", r.category, r."originalPath"
from repair_input r join asset a on a.id = r."assetId"
on conflict ("assetId") do update
set category = excluded.category, "originalPath" = excluded."originalPath", "recordedAt" = now();
insert into invalid_media_path ("originalPath", category)
select "originalPath", category from repair_input
on conflict ("originalPath") do update
set category = excluded.category, "recordedAt" = now();

update asset a set "isOffline" = true
from repair_input r where a.id = r."assetId";

update person p
set "faceAssetId" = null, "thumbnailPath" = ''
where p."faceAssetId" in (
  select f.id from asset_face f join repair_input r on r."assetId" = f."assetId"
);

set local immich.cover_actor = 'auto';
update album al set "albumThumbnailAssetId" = null
where al."albumThumbnailAssetId" in (select "assetId" from repair_input);
update album_cover_policy p
set state = 'pending', "automaticAssetId" = null, "nextAttemptAt" = now(), "lastError" = '', "updatedAt" = now()
where p."albumId" in (
  select distinct aa."albumId" from album_asset aa join repair_input r on r."assetId" = aa."assetId"
) and exists (
  select 1 from album al where al.id = p."albumId" and al."albumThumbnailAssetId" is null
);
commit;
""".format(copy_rows=copy_rows)
    command = ["docker", "exec", "-i", "immich-db", "psql", "-U", "postgres", "-d", "immich"]
    subprocess.run(command, input=sql, text=True, check=True)
    print("Database repair committed; original files were not changed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
