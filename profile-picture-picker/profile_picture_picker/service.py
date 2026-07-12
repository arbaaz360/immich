from __future__ import annotations

import html
import json
import mimetypes
import os
import re
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .models import RunContext
from .pipeline import Pipeline
from .report import write_reports
from .sources import ImmichDbSource
from .stages import (
    ContactSheetStage,
    CropExportStage,
    FaceGeometryStage,
    GroupStage,
    ImageValidationStage,
    OptionalLmStudioVlmStage,
    RankStage,
    SharpnessStage,
    PreselectStage,
)


ROOT = Path(__file__).resolve().parents[1]
RUN_ROOT = ROOT / "profile_picture_service_runs"
IMMICH_PUBLIC_URL_OVERRIDE = os.environ.get("IMMICH_PUBLIC_URL", "").rstrip("/")
LM_STUDIO_MODEL = os.environ.get("LM_STUDIO_MODEL", "").strip()
LM_STUDIO_URL = os.environ.get("LM_STUDIO_URL", "http://localhost:1234/v1/chat/completions").strip()
TOP_PER_ALBUM = int(os.environ.get("PROFILE_PICKER_TOP_PER_ALBUM", "5"))
PRESELECT_PER_ALBUM = int(os.environ.get("PROFILE_PICKER_PRESELECT_PER_ALBUM", "80"))
DEFAULT_LIBRARY_FOLDER = os.environ.get(
    "PROFILE_PICKER_DEFAULT_LIBRARY_FOLDER",
    "X:\\Immich\\uploads\\library\\96e7f049-ce60-47a5-9548-a6ebefd14d85",
)
BULK_STATUS_PATH = RUN_ROOT / "bulk_cover_status.json"
BULK_JOB_LOCK = threading.Lock()
BULK_JOB_THREAD: threading.Thread | None = None
BULK_JOB_STATUS: dict = {}
AUTO_COVERS_ENABLED = os.environ.get("PROFILE_PICKER_AUTO_COVERS", "1") == "1"
AUTO_COVER_INTERVAL = int(os.environ.get("PROFILE_PICKER_AUTO_COVER_INTERVAL", "60"))
AUTO_COVER_GRACE_SECONDS = int(os.environ.get("PROFILE_PICKER_AUTO_COVER_GRACE_SECONDS", "300"))
AUTO_COVER_BATCH_SIZE = int(os.environ.get("PROFILE_PICKER_AUTO_COVER_BATCH_SIZE", "3"))


class ProfilePickerHandler(BaseHTTPRequestHandler):
    server_version = "ImmichProfilePicker/1.0"

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path in {"/", ""}:
                self.send_html(index_page())
            elif path == "/health":
                self.send_text("ok\n")
            elif path == "/api/album-media-counts":
                rows = ImmichDbSource().get_album_media_counts()
                self.send_json(
                    {
                        "albums": {
                            row["album_id"]: {
                                "images": int(row["image_count"]),
                                "videos": int(row["video_count"]),
                            }
                            for row in rows
                        }
                    }
                )
            elif path.startswith("/api/album/") and path.endswith("/candidates"):
                album_id = path.split("/")[3]
                refresh = query.get("refresh") == ["1"]
                if one_or_default(query, "fast", "0") in {"1", "true", "yes"}:
                    payload = fast_album_candidates_payload(album_id)
                else:
                    payload = album_candidates_payload(album_id, self.external_base_url(), refresh=refresh)
                payload.pop("_ranked", None)
                payload.pop("_reports", None)
                self.send_json(payload)
            elif path == "/api/set-cover":
                album_id = one(query, "albumId")
                asset_id = one(query, "assetId")
                source = ImmichDbSource()
                source.set_album_cover(album_id, asset_id)
                self.send_json({"ok": True, "albumId": album_id, "assetId": asset_id})
            elif path == "/bulk-set-covers":
                folder = one_or_default(query, "folder", DEFAULT_LIBRARY_FOLDER)
                limit = int(one_or_default(query, "limit", "0"))
                dry_run = one_or_default(query, "dryRun", "0") in {"1", "true", "yes"}
                self.send_html(bulk_set_covers_page(folder, limit=limit, dry_run=dry_run))
            elif path == "/bulk-start":
                folder = one_or_default(query, "folder", DEFAULT_LIBRARY_FOLDER)
                limit = int(one_or_default(query, "limit", "0"))
                dry_run = one_or_default(query, "dryRun", "0") in {"1", "true", "yes"}
                start_bulk_job(folder, limit=limit, dry_run=dry_run)
                self.send_html(bulk_status_page(immich_public_url(self)))
            elif path == "/bulk-status":
                if one_or_default(query, "json", "0") == "1":
                    self.send_json(read_bulk_status())
                else:
                    self.send_html(bulk_status_page(immich_public_url(self)))
            elif path.startswith("/album/"):
                album_id = path.split("/", 2)[2].strip("/")
                self.send_html(album_page(album_id, immich_public_url(self), refresh=query.get("refresh") == ["1"]))
            elif path == "/set-cover":
                album_id = one(query, "albumId")
                asset_id = one(query, "assetId")
                self.send_html(set_cover_page(album_id, asset_id, immich_public_url(self)))
            elif path.startswith("/files/"):
                self.send_file(RUN_ROOT / urllib.parse.unquote(path[len("/files/") :]))
            else:
                self.send_error(404, "Not found")
        except Exception as exc:
            self.send_html(error_page(exc), status=500)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def send_html(self, body: str, status: int = 200) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_text(self, body: str, status: int = 200) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path: Path) -> None:
        resolved = path.resolve()
        root = RUN_ROOT.resolve()
        if root not in resolved.parents and resolved != root:
            self.send_error(403)
            return
        if not resolved.exists() or not resolved.is_file():
            self.send_error(404)
            return
        data = resolved.read_bytes()
        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", mimetypes.guess_type(str(resolved))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def external_base_url(self) -> str:
        host_header = self.headers.get("Host", "localhost:3111").split(",")[0].strip()
        scheme = "http"
        return f"{scheme}://{host_header}".rstrip("/")


def album_page(album_id: str, public_immich_url: str, refresh: bool = False) -> str:
    validate_uuid(album_id)
    source = ImmichDbSource()
    album = source.get_album(album_id)
    if not album:
        return layout("Album not found", f"<p>No album found for <code>{html.escape(album_id)}</code>.</p>")

    out_dir = RUN_ROOT / album_id
    if refresh and out_dir.exists():
        for file in sorted(out_dir.rglob("*"), reverse=True):
            if file.is_file():
                file.unlink()
            elif file.is_dir():
                try:
                    file.rmdir()
                except OSError:
                    pass

    payload = album_candidates_payload(album_id, "", refresh=refresh)
    ranked = payload["_ranked"]
    reports = payload["_reports"]
    top = sorted(ranked, key=lambda c: c.rank_score, reverse=True)[:TOP_PER_ALBUM]
    title = f"Pick cover: {album['albumName']}"

    if not top:
        body = f"""
        <p>No image face candidates were found for this album. Run Face Detection for this album's assets first.</p>
        <p><a class="button" href="{public_immich_url}/albums/{album_id}">Back to Immich album</a></p>
        """
        return layout(title, body)

    cards = []
    current = album.get("thumbnail_asset_id", "")
    for index, candidate in enumerate(top, 1):
        crop_url = file_url(candidate.output_crop)
        selected = " current-cover" if candidate.asset_id == current else ""
        cards.append(
            f"""
            <article class="card{selected}">
              <img src="{crop_url}" alt="Candidate {index}">
              <div class="meta">
                <strong>#{index}</strong>
                <span>score {candidate.rank_score:.3f}</span>
                <span>body-room {candidate.metrics.get('below_face_ratio', '')}</span>
              </div>
              <div class="actions">
                <a class="button primary" href="/set-cover?albumId={album_id}&assetId={candidate.asset_id}">Set as cover</a>
                <a class="button" target="_blank" href="{public_immich_url}/albums/{album_id}/photos/{candidate.asset_id}">Open</a>
              </div>
              <code>{html.escape(candidate.host_path.name)}</code>
            </article>
            """
        )

    lm = f"<p>LM Studio VLM: <strong>{html.escape(LM_STUDIO_MODEL)}</strong></p>" if LM_STUDIO_MODEL else ""
    body = f"""
    <div class="toolbar">
      <a class="button" href="{public_immich_url}/albums/{album_id}">Back to Immich album</a>
      <a class="button" href="/album/{album_id}?refresh=1">Re-run ranking</a>
      <a class="button" href="{file_url(reports['top_csv'])}">CSV</a>
    </div>
    {lm}
    <section class="grid">{''.join(cards)}</section>
    """
    return layout(title, body)


def run_album_picker(album_id: str, out_dir: Path, *, write_outputs: bool = True, use_vlm: bool | None = None):
    source = ImmichDbSource()
    candidates = source.load_faces(album_id=album_id)
    stages = [
        GroupStage("all"),
        FaceGeometryStage(),
        RankStage(),
        PreselectStage(PRESELECT_PER_ALBUM),
        ImageValidationStage(),
        SharpnessStage(),
        RankStage(),
    ]
    if write_outputs:
        stages.extend(
            [
                CropExportStage(limit_per_group=TOP_PER_ALBUM),
                ContactSheetStage(top_per_group_count=TOP_PER_ALBUM),
            ]
        )
    if use_vlm is None:
        use_vlm = write_outputs
    if use_vlm and LM_STUDIO_MODEL:
        stages.append(OptionalLmStudioVlmStage(LM_STUDIO_MODEL, top_n=min(TOP_PER_ALBUM, 3), endpoint=LM_STUDIO_URL))
    return Pipeline(stages).run(
        candidates,
        RunContext(out_dir=out_dir, write_crops=write_outputs, write_contact_sheets=write_outputs),
    )


def album_candidates_payload(album_id: str, base_url: str, refresh: bool = False) -> dict:
    validate_uuid(album_id)
    source = ImmichDbSource()
    album = source.get_album(album_id)
    if not album:
        raise ValueError(f"Album not found: {album_id}")
    out_dir = RUN_ROOT / album_id
    if refresh and out_dir.exists():
        clear_dir(out_dir)
    ranked = run_album_picker(album_id, out_dir)
    reports = write_reports(ranked, out_dir, top_per_group=TOP_PER_ALBUM)
    top = sorted(ranked, key=lambda c: c.rank_score, reverse=True)[:TOP_PER_ALBUM]
    candidates = []
    for index, candidate in enumerate(top, 1):
        crop_path = candidate.output_crop
        crop_url = file_url(crop_path)
        if base_url and crop_url:
            crop_url = base_url + crop_url
        candidates.append(
            {
                "rank": index,
                "assetId": candidate.asset_id,
                "faceId": candidate.face_id,
                "score": round(candidate.rank_score, 6),
                "fileName": candidate.host_path.name,
                "cropUrl": crop_url,
                "flags": candidate.flags,
                "vlmNote": candidate.vlm_note or "",
                "metrics": {
                    "belowFaceRatio": candidate.metrics.get("below_face_ratio"),
                    "faceHeightRatio": candidate.metrics.get("face_height_ratio"),
                    "sharpness": candidate.metrics.get("sharpness_laplacian_var"),
                },
            }
        )
    return {
        "ok": True,
        "albumId": album_id,
        "albumName": album["albumName"],
        "currentCoverAssetId": album.get("thumbnail_asset_id", ""),
        "candidates": candidates,
        "_ranked": ranked,
        "_reports": reports,
    }


def fast_album_candidates_payload(album_id: str) -> dict:
    validate_uuid(album_id)
    source = ImmichDbSource()
    album = source.get_album(album_id)
    if not album:
        raise ValueError(f"Album not found: {album_id}")

    current_cover = album.get("thumbnail_asset_id", "")
    ranked = run_album_picker_fast(album_id)
    by_asset: dict[str, object] = {}
    for candidate in sorted(ranked, key=lambda c: c.rank_score, reverse=True):
        by_asset.setdefault(candidate.asset_id, candidate)

    selected = []
    if current_cover and current_cover in by_asset:
        selected.append(by_asset.pop(current_cover))
    selected.extend(list(by_asset.values())[: max(0, TOP_PER_ALBUM - len(selected))])

    candidates = []
    for index, candidate in enumerate(selected[:TOP_PER_ALBUM], 1):
        candidates.append(
            {
                "rank": index,
                "assetId": candidate.asset_id,
                "faceId": candidate.face_id,
                "score": round(candidate.rank_score, 6),
                "fileName": candidate.host_path.name,
                "thumbnailUrl": f"/api/assets/{candidate.asset_id}/thumbnail?size=thumbnail",
                "flags": candidate.flags,
                "vlmNote": "",
                "metrics": {
                    "belowFaceRatio": candidate.metrics.get("below_face_ratio"),
                    "faceHeightRatio": candidate.metrics.get("face_height_ratio"),
                    "sharpness": "",
                },
            }
        )

    return {
        "ok": True,
        "fast": True,
        "albumId": album_id,
        "albumName": album["albumName"],
        "currentCoverAssetId": current_cover,
        "candidates": candidates,
    }


def run_album_picker_fast(album_id: str):
    source = ImmichDbSource()
    candidates = source.load_faces(album_id=album_id)
    stages = [
        GroupStage("all"),
        FaceGeometryStage(),
        RankStage(),
        PreselectStage(TOP_PER_ALBUM * 5),
        RankStage(),
    ]
    return Pipeline(stages).run(
        candidates,
        RunContext(out_dir=RUN_ROOT / album_id / "fast", write_crops=False, write_contact_sheets=False),
    )


def bulk_set_covers_page(folder: str, limit: int = 0, dry_run: bool = False) -> str:
    results = bulk_set_covers(folder, limit=limit, dry_run=dry_run)
    rows = []
    for item in results["items"]:
        rows.append(
            "<tr>"
            f"<td>{html.escape(item['albumName'])}</td>"
            f"<td>{html.escape(item['status'])}</td>"
            f"<td>{html.escape(item.get('assetId', ''))}</td>"
            f"<td>{html.escape(item.get('message', ''))}</td>"
            "</tr>"
        )
    body = f"""
    <p>Folder: <code>{html.escape(folder)}</code></p>
    <p>Processed {results['processed']} albums; updated {results['updated']}; skipped {results['skipped']}; failed {results['failed']}.</p>
    <table>
      <thead><tr><th>Album</th><th>Status</th><th>Asset</th><th>Message</th></tr></thead>
      <tbody>{''.join(rows)}</tbody>
    </table>
    <style>
      table {{ border-collapse: collapse; width: 100%; background: white; }}
      th, td {{ border: 1px solid #d8deea; padding: 7px; text-align: left; vertical-align: top; }}
      th {{ background: #eef2f7; }}
    </style>
    """
    return layout("Bulk cover update", body)


def bulk_set_covers(folder: str, limit: int = 0, dry_run: bool = False, progress=None) -> dict:
    source = ImmichDbSource()
    albums = source.list_albums_for_prefix(folder)
    if limit > 0:
        albums = albums[:limit]
    if progress:
        progress({"total": len(albums)})
    items = []
    updated = skipped = failed = 0
    for index, album in enumerate(albums, 1):
        album_id = album["id"]
        if progress:
            progress({"processed": index - 1, "currentAlbum": album.get("album_name", album_id)})
        try:
            if source.album_cover_policy_state(album_id) == "locked":
                skipped += 1
                item = {"albumName": album["album_name"], "status": "skipped", "message": "manual cover locked"}
                items.append(item)
                if progress:
                    progress({"processed": index, "skipped": skipped, "item": item})
                continue
            out_dir = RUN_ROOT / album_id
            ranked = run_album_picker(album_id, out_dir, write_outputs=False, use_vlm=False)
            top = sorted(ranked, key=lambda c: c.rank_score, reverse=True)[:1]
            if not top:
                skipped += 1
                item = {"albumName": album["album_name"], "status": "skipped", "message": "no candidates"}
                items.append(item)
                if progress:
                    progress({"processed": index, "skipped": skipped, "item": item})
                continue
            asset_id = top[0].asset_id
            if not dry_run:
                source.set_album_cover(album_id, asset_id, automatic=True)
            updated += 1
            item = {
                "albumName": album["album_name"],
                "status": "dry-run" if dry_run else "updated",
                "assetId": asset_id,
                "message": f"score={top[0].rank_score:.3f}",
            }
            items.append(item)
            if progress:
                progress({"processed": index, "updated": updated, "item": item})
        except Exception as exc:
            failed += 1
            item = {"albumName": album.get("album_name", album_id), "status": "failed", "message": str(exc)}
            items.append(item)
            if progress:
                progress({"processed": index, "failed": failed, "item": item})
    return {
        "processed": len(albums),
        "updated": updated,
        "skipped": skipped,
        "failed": failed,
        "items": items,
    }


def start_bulk_job(folder: str, limit: int = 0, dry_run: bool = False) -> dict:
    global BULK_JOB_THREAD, BULK_JOB_STATUS
    with BULK_JOB_LOCK:
        if BULK_JOB_THREAD and BULK_JOB_THREAD.is_alive():
            return BULK_JOB_STATUS
        BULK_JOB_STATUS = {
            "running": True,
            "done": False,
            "folder": folder,
            "limit": limit,
            "dryRun": dry_run,
            "startedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "finishedAt": "",
            "total": 0,
            "processed": 0,
            "updated": 0,
            "skipped": 0,
            "failed": 0,
            "currentAlbum": "",
            "error": "",
            "items": [],
        }
        write_bulk_status(BULK_JOB_STATUS)
        BULK_JOB_THREAD = threading.Thread(target=run_bulk_job, args=(folder, limit, dry_run), daemon=True)
        BULK_JOB_THREAD.start()
        return BULK_JOB_STATUS


def run_bulk_job(folder: str, limit: int, dry_run: bool) -> None:
    def progress(update: dict) -> None:
        with BULK_JOB_LOCK:
            item = update.pop("item", None)
            BULK_JOB_STATUS.update(update)
            if item:
                BULK_JOB_STATUS.setdefault("items", []).append(item)
                BULK_JOB_STATUS["items"] = BULK_JOB_STATUS["items"][-200:]
            write_bulk_status(BULK_JOB_STATUS)

    try:
        result = bulk_set_covers(folder, limit=limit, dry_run=dry_run, progress=progress)
        with BULK_JOB_LOCK:
            BULK_JOB_STATUS.update(result)
            BULK_JOB_STATUS["running"] = False
            BULK_JOB_STATUS["done"] = True
            BULK_JOB_STATUS["currentAlbum"] = ""
            BULK_JOB_STATUS["finishedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            BULK_JOB_STATUS["items"] = result.get("items", [])[-200:]
            write_bulk_status(BULK_JOB_STATUS)
    except Exception as exc:
        with BULK_JOB_LOCK:
            BULK_JOB_STATUS["running"] = False
            BULK_JOB_STATUS["done"] = True
            BULK_JOB_STATUS["error"] = type(exc).__name__ + ": " + str(exc)
            BULK_JOB_STATUS["finishedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            write_bulk_status(BULK_JOB_STATUS)


def read_bulk_status() -> dict:
    if BULK_STATUS_PATH.exists():
        try:
            return json.loads(BULK_STATUS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"running": False, "done": False, "items": []}


def write_bulk_status(status: dict) -> None:
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    BULK_STATUS_PATH.write_text(json.dumps(status, indent=2), encoding="utf-8")


def bulk_status_page(public_immich_url: str) -> str:
    status = read_bulk_status()
    rows = []
    for item in status.get("items", [])[-80:]:
        rows.append(
            "<tr>"
            f"<td>{html.escape(item.get('albumName', ''))}</td>"
            f"<td>{html.escape(item.get('status', ''))}</td>"
            f"<td>{html.escape(item.get('assetId', ''))}</td>"
            f"<td>{html.escape(item.get('message', ''))}</td>"
            "</tr>"
        )
    total = int(status.get("total") or 0)
    processed = int(status.get("processed") or 0)
    pct = (processed / total * 100) if total else 0
    refresh = "<meta http-equiv=\"refresh\" content=\"15\">" if status.get("running") else ""
    body = f"""
    {refresh}
    <p><a class="button" href="{public_immich_url}/albums">Back to Immich albums</a></p>
    <p>Folder: <code>{html.escape(status.get('folder', ''))}</code></p>
    <p>Status: <strong>{'running' if status.get('running') else 'finished' if status.get('done') else 'idle'}</strong></p>
    <p>Processed {processed} / {total} albums ({pct:.1f}%); updated {status.get('updated', 0)}; skipped {status.get('skipped', 0)}; failed {status.get('failed', 0)}.</p>
    <p>Current: <code>{html.escape(status.get('currentAlbum', ''))}</code></p>
    <p>Started: {html.escape(status.get('startedAt', ''))} Finished: {html.escape(status.get('finishedAt', ''))}</p>
    <pre>{html.escape(status.get('error', ''))}</pre>
    <table>
      <thead><tr><th>Album</th><th>Status</th><th>Asset</th><th>Message</th></tr></thead>
      <tbody>{''.join(rows)}</tbody>
    </table>
    <style>
      table {{ border-collapse: collapse; width: 100%; background: white; }}
      th, td {{ border: 1px solid #d8deea; padding: 7px; text-align: left; vertical-align: top; }}
      th {{ background: #eef2f7; }}
    </style>
    """
    return layout("Bulk cover status", body)


def set_cover_page(album_id: str, asset_id: str, public_immich_url: str) -> str:
    validate_uuid(album_id)
    validate_uuid(asset_id)
    source = ImmichDbSource()
    source.set_album_cover(album_id, asset_id)
    body = f"""
    <p>Album cover updated to asset <code>{html.escape(asset_id)}</code>.</p>
    <p>
      <a class="button primary" href="{public_immich_url}/albums/{album_id}">Open Immich album</a>
      <a class="button" href="/album/{album_id}">Back to picker</a>
    </p>
    """
    return layout("Cover updated", body)


def index_page() -> str:
    return layout(
        "Immich Profile Picture Picker",
        """
        <p>Open an album from Immich and click <strong>Pick cover</strong>, or use:</p>
        <pre>http://samurai.local:3111/album/&lt;album-id&gt;</pre>
        """,
    )


def layout(title: str, body: str) -> str:
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>
    body {{ font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #162033; background: #f7f8fb; }}
    h1 {{ font-size: 26px; margin: 0 0 18px; }}
    .toolbar {{ display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }}
    .button {{ display: inline-block; padding: 9px 12px; border: 1px solid #c7cedb; border-radius: 6px; text-decoration: none; color: #162033; background: white; }}
    .button.primary {{ background: #2747d8; color: white; border-color: #2747d8; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px; }}
    .card {{ background: white; border: 1px solid #d8deea; border-radius: 8px; padding: 10px; }}
    .card.current-cover {{ outline: 3px solid #35a853; }}
    .card img {{ width: 100%; height: 360px; object-fit: cover; object-position: center top; background: #e9edf5; border-radius: 6px; }}
    .meta {{ display: flex; justify-content: space-between; gap: 8px; margin: 9px 0; font-size: 14px; }}
    .actions {{ display: flex; gap: 8px; margin: 10px 0; }}
    code, pre {{ overflow-wrap: anywhere; white-space: pre-wrap; }}
  </style>
</head>
<body>
  <h1>{html.escape(title)}</h1>
  {body}
</body>
</html>"""


def error_page(exc: Exception) -> str:
    return layout("Error", f"<pre>{html.escape(type(exc).__name__ + ': ' + str(exc))}</pre>")


def one(query: dict[str, list[str]], key: str) -> str:
    values = query.get(key)
    if not values or not values[0]:
        raise ValueError(f"Missing query parameter: {key}")
    return values[0]


def one_or_default(query: dict[str, list[str]], key: str, default: str) -> str:
    values = query.get(key)
    if not values or values[0] == "":
        return default
    return values[0]


def clear_dir(path: Path) -> None:
    for file in sorted(path.rglob("*"), reverse=True):
        if file.is_file():
            file.unlink()
        elif file.is_dir():
            try:
                file.rmdir()
            except OSError:
                pass


def validate_uuid(value: str) -> None:
    if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", value):
        raise ValueError(f"Invalid UUID: {value}")


def immich_public_url(handler: BaseHTTPRequestHandler) -> str:
    if IMMICH_PUBLIC_URL_OVERRIDE and IMMICH_PUBLIC_URL_OVERRIDE.lower() != "auto":
        return IMMICH_PUBLIC_URL_OVERRIDE
    host_header = handler.headers.get("Host", "localhost:3111").split(",")[0].strip()
    if host_header.startswith("["):
        end = host_header.find("]")
        host = host_header[: end + 1] if end >= 0 else host_header
    else:
        host = host_header.split(":", 1)[0]
    return f"http://{host}:2283"


def file_url(path: Path | None) -> str:
    if not path:
        return ""
    rel = path.resolve().relative_to(RUN_ROOT.resolve())
    return "/files/" + urllib.parse.quote(str(rel).replace("\\", "/"))


def auto_cover_worker() -> None:
    source = ImmichDbSource()
    while True:
        try:
            pending = source.list_pending_album_covers(AUTO_COVER_GRACE_SECONDS, AUTO_COVER_BATCH_SIZE)
            for album in pending:
                album_id = album["id"]
                try:
                    ranked = run_album_picker(album_id, RUN_ROOT / album_id, write_outputs=False, use_vlm=False)
                    top = sorted(ranked, key=lambda candidate: candidate.rank_score, reverse=True)[:1]
                    if not top:
                        source.defer_album_cover(album_id, "No image candidates with usable faces")
                        continue
                    source.set_album_cover(album_id, top[0].asset_id, automatic=True)
                    print(f"Automatically set cover for {album.get('album_name', album_id)} to {top[0].asset_id}", flush=True)
                except Exception as exc:
                    source.defer_album_cover(album_id, str(exc))
                    print(f"Automatic cover deferred for {album_id}: {exc}", flush=True)
        except Exception as exc:
            print(f"Automatic cover worker error: {exc}", flush=True)
        time.sleep(max(10, AUTO_COVER_INTERVAL))


def main() -> int:
    host = os.environ.get("PROFILE_PICKER_HOST", "0.0.0.0")
    port = int(os.environ.get("PROFILE_PICKER_PORT", "3111"))
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    source = ImmichDbSource()
    source.ensure_album_cover_policy()
    if AUTO_COVERS_ENABLED:
        threading.Thread(target=auto_cover_worker, name="auto-album-cover", daemon=True).start()
        print("Automatic album-cover policy worker enabled", flush=True)
    server = ThreadingHTTPServer((host, port), ProfilePickerHandler)
    print(f"Immich profile picker listening on http://{host}:{port}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
