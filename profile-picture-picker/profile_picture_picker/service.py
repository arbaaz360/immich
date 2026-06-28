from __future__ import annotations

import html
import mimetypes
import os
import re
import urllib.parse
from datetime import datetime
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

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def send_html(self, body: str, status: int = 200) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_text(self, body: str, status: int = 200) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
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
        self.send_header("Content-Type", mimetypes.guess_type(str(resolved))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


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

    ranked = run_album_picker(album_id, out_dir)
    reports = write_reports(ranked, out_dir, top_per_group=TOP_PER_ALBUM)
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


def run_album_picker(album_id: str, out_dir: Path):
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
        CropExportStage(limit_per_group=TOP_PER_ALBUM),
        ContactSheetStage(top_per_group_count=TOP_PER_ALBUM),
    ]
    if LM_STUDIO_MODEL:
        stages.append(OptionalLmStudioVlmStage(LM_STUDIO_MODEL, top_n=min(TOP_PER_ALBUM, 3), endpoint=LM_STUDIO_URL))
    return Pipeline(stages).run(
        candidates,
        RunContext(out_dir=out_dir, write_crops=True, write_contact_sheets=True),
    )


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


def main() -> int:
    host = os.environ.get("PROFILE_PICKER_HOST", "0.0.0.0")
    port = int(os.environ.get("PROFILE_PICKER_PORT", "3111"))
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((host, port), ProfilePickerHandler)
    print(f"Immich profile picker listening on http://{host}:{port}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
