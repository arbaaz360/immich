from __future__ import annotations

import csv
import os
import subprocess
from pathlib import Path

from .models import Candidate


def host_to_container_prefix(path: str | Path) -> str:
    raw = str(path).replace("/", "\\").rstrip("\\")
    lower = raw.lower()

    uploads_root = "x:\\immich\\uploads"
    library_root = "x:\\immich\\uploads\\library"
    external_root = "x:\\immich\\uploads\\library"

    if lower == library_root or lower.startswith(library_root + "\\"):
        rel = raw[len(external_root) :].replace("\\", "/")
        return "/external" + rel
    if lower == uploads_root:
        return "/data"
    if lower.startswith(uploads_root + "\\"):
        rel = raw[len(uploads_root) :].replace("\\", "/")
        return "/data" + rel
    raise ValueError(f"Do not know how to map host path to Immich container path: {path}")


def container_to_host_path(path: str) -> Path:
    normalized = path.replace("\\", "/")
    if os.environ.get("IMMICH_PROFILE_PICKER_DOCKER") == "1":
        if normalized == "/data":
            return Path("/data")
        if normalized.startswith("/data/"):
            return Path("/data") / normalized[len("/data/") :]
        if normalized == "/external":
            return Path("/external")
        if normalized.startswith("/external/"):
            return Path("/external") / normalized[len("/external/") :]
    if normalized == "/data":
        return Path("X:/Immich/uploads")
    if normalized.startswith("/data/"):
        return Path("X:/Immich/uploads") / normalized[len("/data/") :]
    if normalized == "/external":
        return Path("X:/Immich/uploads/library")
    if normalized.startswith("/external/"):
        return Path("X:/Immich/uploads/library") / normalized[len("/external/") :]
    return Path(path)


class ImmichDbSource:
    def __init__(self, container_name: str = "immich-db") -> None:
        self.container_name = container_name
        self.use_direct_psql = bool(os.environ.get("DB_HOSTNAME"))

    def load_faces(
        self,
        *,
        folder: str | Path | None = None,
        album_id: str | None = None,
        library_id: str | None = None,
        person_id: str | None = None,
        limit: int | None = None,
    ) -> list[Candidate]:
        where = [
            'af."deletedAt" is null',
            'coalesce(af."isVisible", true) is true',
            'a."deletedAt" is null',
            "a.status = 'active'",
            "a.type = 'IMAGE'",
        ]
        if folder:
            prefix = host_to_container_prefix(folder)
            where.append(f"a.\"originalPath\" like {sql_literal(prefix.rstrip('/') + '/%')}")
        if library_id:
            where.append(f'a."libraryId" = {sql_literal(library_id)}::uuid')
        if person_id:
            where.append(f'af."personId" = {sql_literal(person_id)}::uuid')
        join_album = ""
        if album_id:
            join_album = 'join album_asset aa on aa."assetId" = a.id'
            where.append(f'aa."albumId" = {sql_literal(album_id)}::uuid')

        limit_sql = f"limit {int(limit)}" if limit else ""
        sql = f"""
copy (
  select
    af.id as face_id,
    af."assetId" as asset_id,
    af."personId" as person_id,
    p.name as person_name,
    a."originalPath" as original_path,
    coalesce(a.width, af."imageWidth") as image_width,
    coalesce(a.height, af."imageHeight") as image_height,
    af."boundingBoxX1" as x1,
    af."boundingBoxY1" as y1,
    af."boundingBoxX2" as x2,
    af."boundingBoxY2" as y2,
    count(*) over (partition by af."assetId") as faces_in_asset
  from asset_face af
  join asset a on a.id = af."assetId"
  {join_album}
  left join person p on p.id = af."personId"
  where {" and ".join(where)}
  order by a."localDateTime" desc nulls last, a."createdAt" desc
  {limit_sql}
) to stdout with csv header
"""
        rows = self._copy_rows(sql)
        candidates: list[Candidate] = []
        for row in rows:
            original_path = row["original_path"]
            candidates.append(
                Candidate(
                    face_id=row["face_id"],
                    asset_id=row["asset_id"],
                    person_id=row.get("person_id") or None,
                    person_name=row.get("person_name") or None,
                    original_path=original_path,
                    host_path=container_to_host_path(original_path),
                    image_width=int(row["image_width"]),
                    image_height=int(row["image_height"]),
                    face_box=(int(row["x1"]), int(row["y1"]), int(row["x2"]), int(row["y2"])),
                    faces_in_asset=int(row["faces_in_asset"] or 1),
                )
            )
        return candidates

    def get_album(self, album_id: str) -> dict[str, str] | None:
        sql = f"""
copy (
  select id, "albumName", coalesce("albumThumbnailAssetId"::text, '') as thumbnail_asset_id
  from album
  where id = {sql_literal(album_id)}::uuid and "deletedAt" is null
) to stdout with csv header
"""
        rows = self._copy_rows(sql)
        return rows[0] if rows else None

    def get_album_media_counts(self) -> list[dict[str, str]]:
        """Return active image/video membership counts for every non-deleted album."""
        sql = """
copy (
  select
    al.id::text as album_id,
    count(*) filter (where a.type = 'IMAGE')::text as image_count,
    count(*) filter (where a.type = 'VIDEO')::text as video_count
  from album al
  left join album_asset aa on aa."albumId" = al.id
  left join asset a
    on a.id = aa."assetId"
   and a."deletedAt" is null
   and a.status = 'active'
  where al."deletedAt" is null
  group by al.id
  order by al.id
) to stdout with csv header
"""
        return self._copy_rows(sql)

    def list_albums_for_prefix(self, folder: str | Path) -> list[dict[str, str]]:
        prefix = host_to_container_prefix(folder).rstrip("/") + "/"
        folder_rows = self._direct_child_folder_rows(prefix.rstrip("/"))
        if 0 < len(folder_rows) <= 500:
            return self._list_albums_for_folder_rows(folder_rows)

        sql = f"""
copy (
  select distinct
    al.id::text as id,
    al."albumName" as album_name,
    coalesce(al."albumThumbnailAssetId"::text, '') as thumbnail_asset_id
  from album al
  join album_asset aa on aa."albumId" = al.id
  join asset a on a.id = aa."assetId"
  where al."deletedAt" is null
    and a."deletedAt" is null
    and a.status = 'active'
    and a.type = 'IMAGE'
    and a."originalPath" like {sql_literal(prefix + '%')}
  order by al."albumName"
) to stdout with csv header
"""
        return self._copy_rows(sql)

    def _direct_child_folder_rows(self, container_prefix: str) -> list[dict[str, str]]:
        root = container_to_host_path(container_prefix)
        if not root.exists() or not root.is_dir():
            return []
        rows = []
        for index, child in enumerate(sorted(root.iterdir(), key=lambda path: path.name.lower()), 1):
            if child.is_dir():
                rows.append(
                    {
                        "ord": str(index),
                        "album_name": child.name,
                        "asset_prefix": container_prefix.rstrip("/") + "/" + child.name,
                    }
                )
        return rows

    def _list_albums_for_folder_rows(self, folder_rows: list[dict[str, str]]) -> list[dict[str, str]]:
        albums: list[dict[str, str]] = []
        chunk_size = 400
        for start in range(0, len(folder_rows), chunk_size):
            values_sql = ",\n    ".join(
                f"({row['ord']}, {sql_literal(row['album_name'])}, {sql_literal(row['asset_prefix'])})"
                for row in folder_rows[start : start + chunk_size]
            )
            sql = f"""
copy (
  with wanted(ord, album_name, asset_prefix) as (
    values
    {values_sql}
  )
  select
    al.id::text as id,
    al."albumName" as album_name,
    coalesce(al."albumThumbnailAssetId"::text, '') as thumbnail_asset_id,
    w.ord::text as folder_order,
    w.asset_prefix
  from wanted w
  join album al on al."albumName" = w.album_name
  where al."deletedAt" is null
    and exists (
      select 1
      from album_asset aa
      join asset a on a.id = aa."assetId"
      where aa."albumId" = al.id
        and a."deletedAt" is null
        and a.status = 'active'
        and a.type = 'IMAGE'
        and a."originalPath" like w.asset_prefix || '/%'
      limit 1
    )
  order by w.ord, al."albumName"
) to stdout with csv header
"""
            albums.extend(self._copy_rows(sql))
        return albums

    def ensure_album_cover_policy(self) -> None:
        sql = """
create table if not exists album_cover_policy (
  "albumId" uuid primary key references album(id) on delete cascade,
  state text not null check (state in ('pending', 'automatic', 'locked')),
  "automaticAssetId" uuid references asset(id) on delete set null,
  attempts integer not null default 0,
  "nextAttemptAt" timestamptz not null default now(),
  "lastError" text not null default '',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

insert into album_cover_policy ("albumId", state, "automaticAssetId")
select id,
       case when "albumThumbnailAssetId" is null then 'pending' else 'locked' end,
       null
from album
where "deletedAt" is null
on conflict ("albumId") do nothing;

create or replace function maintain_album_cover_policy() returns trigger language plpgsql as $$
declare
  actor text := current_setting('immich.cover_actor', true);
begin
  if tg_op = 'INSERT' then
    insert into album_cover_policy ("albumId", state)
    values (new.id, 'pending')
    on conflict ("albumId") do nothing;
    return new;
  end if;

  if new."albumThumbnailAssetId" is distinct from old."albumThumbnailAssetId" then
    insert into album_cover_policy ("albumId", state)
    values (new.id, 'pending')
    on conflict ("albumId") do nothing;

    if actor = 'auto' then
      update album_cover_policy
      set state = 'automatic',
          "automaticAssetId" = new."albumThumbnailAssetId",
          "lastError" = '',
          "updatedAt" = now()
      where "albumId" = new.id and state <> 'locked';
    elsif actor = 'manual' or old."albumThumbnailAssetId" is not null then
      update album_cover_policy
      set state = 'locked',
          "automaticAssetId" = null,
          "lastError" = '',
          "updatedAt" = now()
      where "albumId" = new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists album_cover_policy_insert on album;
create trigger album_cover_policy_insert
after insert on album for each row execute function maintain_album_cover_policy();
drop trigger if exists album_cover_policy_update on album;
create trigger album_cover_policy_update
after update of "albumThumbnailAssetId" on album
for each row execute function maintain_album_cover_policy();
"""
        self._psql(sql)

    def list_pending_album_covers(self, grace_seconds: int, limit: int) -> list[dict[str, str]]:
        sql = f"""
copy (
  select al.id::text as id, al."albumName" as album_name
  from album_cover_policy p
  join album al on al.id = p."albumId"
  where p.state = 'pending'
    and p."nextAttemptAt" <= now()
    and al."deletedAt" is null
    and al."createdAt" <= now() - make_interval(secs => {int(grace_seconds)})
    and exists (
      select 1
      from album_asset aa
      join asset a on a.id = aa."assetId"
      join asset_file af on af."assetId" = a.id and af.type = 'thumbnail' and af."isEdited" = false
      join asset_face face on face."assetId" = a.id and face."deletedAt" is null and coalesce(face."isVisible", true)
      where aa."albumId" = al.id
        and a.type = 'IMAGE' and a.status = 'active' and a."deletedAt" is null
    )
  order by al."createdAt", al.id
  limit {int(limit)}
) to stdout with csv header;
"""
        return self._copy_rows(sql)

    def defer_album_cover(self, album_id: str, error: str, retry_seconds: int = 900) -> None:
        sql = f"""
update album_cover_policy
set attempts = attempts + 1,
    "nextAttemptAt" = now() + make_interval(secs => {int(retry_seconds)}),
    "lastError" = left({sql_literal(error)}, 2000),
    "updatedAt" = now()
where "albumId" = {sql_literal(album_id)}::uuid and state = 'pending';
"""
        self._psql(sql)

    def album_cover_policy_state(self, album_id: str) -> str:
        sql = f"""
copy (
  select state from album_cover_policy where "albumId" = {sql_literal(album_id)}::uuid
) to stdout with csv header;
"""
        rows = self._copy_rows(sql)
        return rows[0]["state"] if rows else "pending"

    def set_album_cover(self, album_id: str, asset_id: str, *, automatic: bool = False) -> None:
        actor = "auto" if automatic else "manual"
        policy_guard = (
            f"and exists (select 1 from album_cover_policy p where p.\"albumId\" = al.id and p.state <> 'locked')"
            if automatic
            else ""
        )
        policy_update = (
            f"update album_cover_policy set state = 'automatic', \"automaticAssetId\" = {sql_literal(asset_id)}::uuid, \"lastError\" = '', \"updatedAt\" = now() where \"albumId\" = {sql_literal(album_id)}::uuid and state <> 'locked' and exists (select 1 from album where id = {sql_literal(album_id)}::uuid and \"albumThumbnailAssetId\" = {sql_literal(asset_id)}::uuid);"
            if automatic
            else f"update album_cover_policy set state = 'locked', \"automaticAssetId\" = null, \"lastError\" = '', \"updatedAt\" = now() where \"albumId\" = {sql_literal(album_id)}::uuid and exists (select 1 from album where id = {sql_literal(album_id)}::uuid and \"albumThumbnailAssetId\" = {sql_literal(asset_id)}::uuid);"
        )
        sql = f"""
begin;
set local immich.cover_actor = '{actor}';
copy (
with updated as (
update album al
set "albumThumbnailAssetId" = aa."assetId",
    "updatedAt" = now(),
    "updateId" = immich_uuid_v7()
from album_asset aa
join asset a on a.id = aa."assetId"
where al.id = aa."albumId"
  and al.id = {sql_literal(album_id)}::uuid
  and aa."assetId" = {sql_literal(asset_id)}::uuid
  and a.type = 'IMAGE'
  and a.status = 'active'
  and a."deletedAt" is null
  {policy_guard}
  returning al.id, al."albumThumbnailAssetId"::text as thumbnail_asset_id
)
select id, thumbnail_asset_id from updated
) to stdout with csv header;
{policy_update}
commit;
"""
        rows = self._copy_rows(sql)
        if not rows or rows[0].get("thumbnail_asset_id") != asset_id:
            raise RuntimeError("Album cover was not updated")

    def _copy_rows(self, sql: str) -> list[dict[str, str]]:
        result = self._psql(sql)
        return list(csv.DictReader(result.stdout.splitlines()))

    def _psql(self, sql: str) -> subprocess.CompletedProcess[str]:
        if self.use_direct_psql:
            env = os.environ.copy()
            env["PGPASSWORD"] = env.get("DB_PASSWORD", env.get("POSTGRES_PASSWORD", "postgres"))
            result = subprocess.run(
                [
                    "psql",
                    "-h",
                    env.get("DB_HOSTNAME", "database"),
                    "-p",
                    env.get("DB_PORT", "5432"),
                    "-U",
                    env.get("DB_USERNAME", "postgres"),
                    "-d",
                    env.get("DB_DATABASE_NAME", "immich"),
                    "-q",
                ],
                input=sql,
                text=True,
                capture_output=True,
                check=False,
                env=env,
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or result.stdout.strip())
            return result

        result = subprocess.run(
            ["docker", "exec", "-i", self.container_name, "psql", "-U", "postgres", "-d", "immich", "-q"],
            input=sql,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip())
        return result


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
