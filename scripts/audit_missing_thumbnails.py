#!/usr/bin/env python3
"""Audit and optionally reconcile Immich thumbnail rows with files on the SSD.

Only thumbnail records are considered. Preview records are deliberately ignored.
Original assets are never modified.
"""

from __future__ import annotations

import argparse
import csv
import os
from pathlib import Path
import subprocess
import sys


DB_CONTAINER = "immich-db"
THUMBS_ROOT = Path(r"C:\Immich\uploads\thumbs")
CACHE_ROOT = Path(r"C:\Immich\thumbnail-cache")


def psql_copy(sql: str):
    command = [
        "docker", "exec", "-i", DB_CONTAINER,
        "psql", "-U", "postgres", "-d", "immich", "-qAt", "-c", sql,
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
    assert process.stdout is not None
    yield from csv.reader(process.stdout)
    return_code = process.wait()
    if return_code:
        raise RuntimeError(f"psql exited with {return_code}")


def thumbnail_host_path(container_path: str, root: Path) -> Path | None:
    normalized = container_path.replace("\\", "/")
    prefix = "/data/thumbs/"
    if not normalized.startswith(prefix):
        return None
    return root / Path(normalized[len(prefix):].replace("/", os.sep))


def audit_assets(writer: csv.writer) -> list[str]:
    sql = '''copy (
      select a.id::text, af.path
      from asset a
      join asset_file af on af."assetId" = a.id and af.type = 'thumbnail' and af."isEdited" = false
      where a."deletedAt" is null and a.status = 'active'
    ) to stdout with csv'''
    missing: list[str] = []
    checked = 0
    for asset_id, container_path in psql_copy(sql):
        checked += 1
        normal_path = thumbnail_host_path(container_path, THUMBS_ROOT)
        cache_path = thumbnail_host_path(container_path, CACHE_ROOT)
        exists = bool(normal_path and normal_path.is_file()) or bool(cache_path and cache_path.is_file())
        if not exists:
            missing.append(asset_id)
            writer.writerow(["asset", asset_id, container_path])
        if checked % 100_000 == 0:
            print(f"Checked {checked:,} asset thumbnails; missing {len(missing):,}", flush=True)
    print(f"Asset audit complete: checked {checked:,}; missing {len(missing):,}", flush=True)
    return missing


def audit_people(writer: csv.writer) -> list[str]:
    sql = '''copy (
      select id::text, "thumbnailPath"
      from person
      where "thumbnailPath" <> ''
    ) to stdout with csv'''
    missing: list[str] = []
    checked = 0
    for person_id, container_path in psql_copy(sql):
        checked += 1
        normal_path = thumbnail_host_path(container_path, THUMBS_ROOT)
        if not normal_path or not normal_path.is_file():
            missing.append(person_id)
            writer.writerow(["person", person_id, container_path])
    print(f"Person audit complete: checked {checked:,}; missing {len(missing):,}", flush=True)
    return missing


def reconcile(asset_ids: list[str], person_ids: list[str]) -> None:
    sql = r"""
begin;
create temporary table repair_asset (id uuid primary key);
create temporary table repair_person (id uuid primary key);
copy repair_asset (id) from stdin;
{asset_rows}\.
copy repair_person (id) from stdin;
{person_rows}\.
delete from asset_file af using repair_asset r
where af."assetId" = r.id and af.type = 'thumbnail' and af."isEdited" = false;
update asset a set thumbhash = null from repair_asset r where a.id = r.id;
update person p set "thumbnailPath" = '' from repair_person r where p.id = r.id;
commit;
""".format(
        asset_rows="".join(f"{item}\n" for item in asset_ids),
        person_rows="".join(f"{item}\n" for item in person_ids),
    )
    command = ["docker", "exec", "-i", DB_CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "immich"]
    subprocess.run(command, input=sql, text=True, check=True)
    print(f"Reconciled {len(asset_ids):,} assets and {len(person_ids):,} people.", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["kind", "id", "database_path"])
        asset_ids = audit_assets(writer)
        person_ids = audit_people(writer)
    if args.apply:
        reconcile(asset_ids, person_ids)
    else:
        print("Audit only; use --apply to reconcile database state.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
