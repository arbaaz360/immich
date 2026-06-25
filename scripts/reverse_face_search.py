#!/usr/bin/env python3
import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import closing
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


IMMICH_BASE_URL = "http://localhost:2283"
IMMICH_INTERNAL_URL = os.environ.get("IMMICH_INTERNAL_URL", "http://immich-server:2283")
IMMICH_ML_URL = os.environ.get("IMMICH_ML_URL", "http://immich-ml:3003")
DEFAULT_BIND = os.environ.get("BIND_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("PORT", "2299"))
MODEL_NAME = "buffalo_l"
MIN_FACE_SCORE = 0.7
DEFAULT_LIMIT = 20
DEFAULT_THRESHOLD = 0.5

LOCAL_API_KEY_FILE = Path(__file__).with_name("immich_api_keys.local.txt")
LOCAL_COMPOSE_FILE = Path(r"X:\Immich\docker-compose.yml")

INSTAGRAM_OWNER_IDS = [
    "274e2f91-7d8d-4478-b03b-00288bc25c42",
    "96e7f049-ce60-47a5-9548-a6ebefd14d85",
]


def run_command(args, *, input_text=None, timeout=120):
    result = subprocess.run(
        args,
        input=input_text,
        text=input_text is not None,
        capture_output=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Command failed:\n"
            + " ".join(args)
            + "\n\nSTDOUT:\n"
            + result.stdout
            + "\n\nSTDERR:\n"
            + result.stderr
        )
    return result.stdout


def get_immich_api_keys():
    keys = []
    env_keys = os.environ.get("IMMICH_API_KEYS", "")
    keys.extend([key.strip() for key in re.split(r"[,;\r\n]+", env_keys) if key.strip()])

    if LOCAL_API_KEY_FILE.exists():
        keys.extend([line.strip() for line in LOCAL_API_KEY_FILE.read_text(encoding="utf-8").splitlines() if line.strip()])

    if LOCAL_COMPOSE_FILE.exists():
        compose = LOCAL_COMPOSE_FILE.read_text(encoding="utf-8", errors="ignore")
        keys.extend(re.findall(r"API_KEY:\s*[\"']?([^\"'\r\n]+)", compose))

    seen = set()
    unique = []
    for key in keys:
        if key not in seen:
            unique.append(key)
            seen.add(key)
    return unique


def running_in_docker_service():
    return bool(os.environ.get("DB_HOSTNAME") or os.environ.get("IMMICH_REVERSE_FACE_DOCKER"))


def ensure_docker_available():
    for container in ("immich-server", "immich-ml", "immich-db"):
        run_command(["docker", "inspect", container], timeout=15)


def container_path_for(local_path):
    suffix = f"{uuid.uuid4().hex}_{Path(local_path).name}"
    return f"/tmp/immich_reverse_face_search/{suffix}"


def detect_query_faces(local_image_path):
    if running_in_docker_service():
        return detect_query_faces_direct(local_image_path)

    container_path = container_path_for(local_image_path)
    entries = {
        "facial-recognition": {
            "detection": {"modelName": MODEL_NAME, "options": {"minScore": MIN_FACE_SCORE}},
            "recognition": {"modelName": MODEL_NAME},
        }
    }

    run_command(["docker", "exec", "immich-server", "mkdir", "-p", "/tmp/immich_reverse_face_search"], timeout=15)
    run_command(["docker", "cp", str(local_image_path), f"immich-server:{container_path}"], timeout=120)
    try:
        raw = run_command(
            [
                "docker",
                "exec",
                "immich-server",
                "curl",
                "-sS",
                "-X",
                "POST",
                "http://immich-ml:3003/predict",
                "-F",
                f"entries={json.dumps(entries, separators=(',', ':'))}",
                "-F",
                f"image=@{container_path}",
            ],
            timeout=300,
        )
        response = json.loads(raw)
    finally:
        subprocess.run(
            ["docker", "exec", "immich-server", "rm", "-f", container_path],
            capture_output=True,
            timeout=30,
        )

    return response.get("facial-recognition", []), response


def multipart_body(fields, files):
    boundary = "----immichReverseFaceSearch" + uuid.uuid4().hex
    chunks = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(str(value).encode())
        chunks.append(b"\r\n")
    for name, file_info in files.items():
        filename, content_type, payload = file_info
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n".encode()
        )
        chunks.append(payload)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return boundary, b"".join(chunks)


def detect_query_faces_direct(local_image_path):
    entries = {
        "facial-recognition": {
            "detection": {"modelName": MODEL_NAME, "options": {"minScore": MIN_FACE_SCORE}},
            "recognition": {"modelName": MODEL_NAME},
        }
    }
    payload = Path(local_image_path).read_bytes()
    boundary, body = multipart_body(
        {"entries": json.dumps(entries, separators=(",", ":"))},
        {"image": (Path(local_image_path).name, "application/octet-stream", payload)},
    )
    request = Request(
        f"{IMMICH_ML_URL.rstrip('/')}/predict",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urlopen(request, timeout=300) as response:
        decoded = json.loads(response.read())
    return decoded.get("facial-recognition", []), decoded


def sql_string(value):
    return "'" + value.replace("'", "''") + "'"


def query_matches(embedding, *, limit, threshold, scope):
    if running_in_docker_service():
        return query_matches_direct(embedding, limit=limit, threshold=threshold, scope=scope)

    try:
        vector = json.loads(embedding)
    except json.JSONDecodeError as exc:
        raise RuntimeError("ML returned an embedding format that could not be parsed") from exc

    if not isinstance(vector, list) or len(vector) != 512:
        raise RuntimeError(f"Expected a 512-value face embedding, got {len(vector) if isinstance(vector, list) else type(vector)}")

    vector_literal = "[" + ",".join(str(float(value)) for value in vector) + "]"
    owner_filter = ""
    if scope == "instagram":
        owner_filter = 'AND a."ownerId" IN (' + ",".join(sql_string(owner_id) for owner_id in INSTAGRAM_OWNER_IDS) + ")"

    sql = f"""
WITH q AS (
  SELECT $face_vector${vector_literal}$face_vector$::vector AS embedding
),
ranked AS (
  SELECT
    a.id AS "assetId",
    af.id AS "faceId",
    af."personId" AS "personId",
    NULLIF(p.name, '') AS "personName",
    a."ownerId" AS "ownerId",
    a."originalFileName" AS "originalFileName",
    a."originalPath" AS "originalPath",
    a."fileCreatedAt" AS "fileCreatedAt",
    af."boundingBoxX1" AS "x1",
    af."boundingBoxY1" AS "y1",
    af."boundingBoxX2" AS "x2",
    af."boundingBoxY2" AS "y2",
    fs.embedding <=> q.embedding AS distance
  FROM face_search fs
  JOIN asset_face af ON af.id = fs."faceId"
  JOIN asset a ON a.id = af."assetId"
  LEFT JOIN person p ON p.id = af."personId"
  CROSS JOIN q
  WHERE af."deletedAt" IS NULL
    AND af."isVisible" IS TRUE
    AND a."deletedAt" IS NULL
    AND a.visibility = 'timeline'
    {owner_filter}
  ORDER BY fs.embedding <=> q.embedding
  LIMIT {int(limit)}
)
SELECT COALESCE(json_agg(row_to_json(ranked)), '[]'::json) FROM ranked;
"""
    output = run_command(
        ["docker", "exec", "-i", "immich-db", "psql", "-U", "postgres", "-d", "immich", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input_text=sql,
        timeout=120,
    ).strip()
    matches = json.loads(output or "[]")
    return [match for match in matches if float(match["distance"]) <= threshold]


def query_matches_direct(embedding, *, limit, threshold, scope):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as exc:
        raise RuntimeError("Docker mode requires psycopg. Rebuild the reverse-face-search image.") from exc

    try:
        vector = json.loads(embedding)
    except json.JSONDecodeError as exc:
        raise RuntimeError("ML returned an embedding format that could not be parsed") from exc

    if not isinstance(vector, list) or len(vector) != 512:
        raise RuntimeError(f"Expected a 512-value face embedding, got {len(vector) if isinstance(vector, list) else type(vector)}")

    vector_literal = "[" + ",".join(str(float(value)) for value in vector) + "]"
    params = {"embedding": vector_literal, "limit": int(limit)}
    owner_filter = ""
    if scope == "instagram":
        owner_filter = 'AND a."ownerId" = ANY(%(owner_ids)s::uuid[])'
        params["owner_ids"] = INSTAGRAM_OWNER_IDS

    sql = f"""
WITH q AS (
  SELECT %(embedding)s::vector AS embedding
)
SELECT
  a.id::text AS "assetId",
  af.id::text AS "faceId",
  af."personId"::text AS "personId",
  NULLIF(p.name, '') AS "personName",
  a."ownerId"::text AS "ownerId",
  a."originalFileName" AS "originalFileName",
  a."originalPath" AS "originalPath",
  a."fileCreatedAt"::text AS "fileCreatedAt",
  af."boundingBoxX1" AS "x1",
  af."boundingBoxY1" AS "y1",
  af."boundingBoxX2" AS "x2",
  af."boundingBoxY2" AS "y2",
  fs.embedding <=> q.embedding AS distance
FROM face_search fs
JOIN asset_face af ON af.id = fs."faceId"
JOIN asset a ON a.id = af."assetId"
LEFT JOIN person p ON p.id = af."personId"
CROSS JOIN q
WHERE af."deletedAt" IS NULL
  AND af."isVisible" IS TRUE
  AND a."deletedAt" IS NULL
  AND a.visibility = 'timeline'
  {owner_filter}
ORDER BY fs.embedding <=> q.embedding
LIMIT %(limit)s;
"""
    conninfo = {
        "host": os.environ.get("DB_HOSTNAME", "database"),
        "port": int(os.environ.get("DB_PORT", "5432")),
        "user": os.environ.get("DB_USERNAME", "postgres"),
        "password": os.environ.get("DB_PASSWORD", "postgres"),
        "dbname": os.environ.get("DB_DATABASE_NAME", "immich"),
    }
    with closing(psycopg.connect(**conninfo, row_factory=dict_row)) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            matches = cur.fetchall()
    return [dict(match) for match in matches if float(match["distance"]) <= threshold]


def container_path_to_host(path):
    mappings = [
        ("/external/", r"X:\Immich\uploads\library"),
        ("/data/", r"X:\Immich\uploads"),
        ("/mnt/e/", r"E:"),
    ]
    normalized = path.replace("\\", "/")
    for prefix, host_prefix in mappings:
        if normalized.startswith(prefix):
            rest = normalized[len(prefix) :].replace("/", "\\")
            return host_prefix + "\\" + rest
    return path


def search_image(local_image_path, *, limit=DEFAULT_LIMIT, threshold=DEFAULT_THRESHOLD, scope="all"):
    if not running_in_docker_service():
        ensure_docker_available()
    faces, ml_response = detect_query_faces(local_image_path)
    results = []
    for index, face in enumerate(faces, start=1):
        matches = query_matches(face["embedding"], limit=limit, threshold=threshold, scope=scope)
        for match in matches:
            match["originalHostPath"] = container_path_to_host(match["originalPath"])
            match["photoUrl"] = f"{os.environ.get('IMMICH_PUBLIC_URL', IMMICH_BASE_URL).rstrip('/')}/photos/{match['assetId']}"
            match["thumbnailUrl"] = f"/thumb?assetId={match['assetId']}"
            match["similarity"] = 1 - float(match["distance"])
        results.append({"queryFace": index, "face": face, "matches": matches})
    return {"facesFound": len(faces), "image": str(local_image_path), "results": results, "ml": ml_response}


def download_query_image(image_url):
    parsed = urlparse(image_url)
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError("Only http/https image URLs can be fetched from the context menu")

    headers = {"User-Agent": "ImmichReverseFaceSearch/1.0"}
    urls_and_headers = [(image_url, headers)]
    if parsed.netloc.split("@")[-1].split(":")[0] in {"localhost", "127.0.0.1", "immich-server"}:
        for api_key in get_immich_api_keys():
            urls_and_headers.append((image_url, {**headers, "x-api-key": api_key}))

    last_error = None
    for url, request_headers in urls_and_headers:
        request = Request(url, headers=request_headers)
        try:
            with urlopen(request, timeout=60) as response:
                content_type = response.headers.get("Content-Type", "")
                if not content_type.startswith("image/"):
                    raise RuntimeError(f"URL did not return an image. Content-Type: {content_type or 'unknown'}")
                payload = response.read(25 * 1024 * 1024 + 1)
                break
        except Exception as exc:
            last_error = exc
    else:
        raise RuntimeError(f"Could not fetch image URL: {last_error}")

    if len(payload) > 25 * 1024 * 1024:
        raise RuntimeError("Image is larger than the 25 MB context-menu fetch limit")

    suffix = ".jpg"
    if "png" in content_type:
        suffix = ".png"
    elif "webp" in content_type:
        suffix = ".webp"
    elif "gif" in content_type:
        suffix = ".gif"

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(payload)
        return Path(tmp.name)


def render_page(body):
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Immich Reverse Face Search</title>
  <style>
    body {{ font-family: Segoe UI, Arial, sans-serif; margin: 24px; color: #1f2937; background: #f7f8fa; }}
    main {{ max-width: 1100px; margin: 0 auto; }}
    form, .section {{ background: #fff; border: 1px solid #d8dde6; border-radius: 8px; padding: 16px; margin-bottom: 16px; }}
    label {{ display: block; margin: 10px 0 4px; font-weight: 600; }}
    input, select, button {{ font: inherit; }}
    input[type=file] {{ width: 100%; }}
    input[type=number], select {{ padding: 6px 8px; border: 1px solid #c6ccd7; border-radius: 6px; }}
    button {{ padding: 8px 14px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }}
    table {{ width: 100%; border-collapse: collapse; margin-top: 10px; background: #fff; }}
    th, td {{ text-align: left; padding: 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }}
    th {{ font-size: 13px; color: #4b5563; }}
    img.thumb {{ width: 72px; height: 72px; object-fit: cover; border-radius: 6px; background: #e5e7eb; }}
    .muted {{ color: #6b7280; font-size: 13px; }}
    .path {{ font-family: Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }}
    .error {{ color: #b91c1c; white-space: pre-wrap; }}
  </style>
</head>
<body>
<main>
  <h1>Immich Reverse Face Search</h1>
  <form method="post" enctype="multipart/form-data">
    <label for="image">Query image</label>
    <input id="image" name="image" type="file" accept="image/*" required>
    <label for="scope">Search scope</label>
    <select id="scope" name="scope">
      <option value="all">All Immich faces</option>
      <option value="instagram">Only the two Instagram owners</option>
    </select>
    <label for="threshold">Max cosine distance</label>
    <input id="threshold" name="threshold" type="number" step="0.01" min="0" max="2" value="{DEFAULT_THRESHOLD}">
    <span class="muted">Lower is stricter. Immich's face grouping default is 0.5.</span>
    <label for="limit">Candidates per detected query face</label>
    <input id="limit" name="limit" type="number" min="1" max="100" value="{DEFAULT_LIMIT}">
    <div style="margin-top:14px"><button type="submit">Search</button></div>
  </form>
  {body}
</main>
</body>
</html>"""


def render_results(payload):
    if payload["facesFound"] == 0:
        return '<div class="section">No face was detected in the query image.</div>'

    sections = []
    for item in payload["results"]:
        matches = item["matches"]
        face = item["face"]
        rows = []
        for match in matches:
            name = html.escape(match.get("personName") or "")
            rows.append(
                "<tr>"
                f"<td><img class='thumb' src='{html.escape(match['thumbnailUrl'])}'></td>"
                f"<td><a href='{html.escape(match['photoUrl'])}' target='_blank'>{html.escape(match['assetId'])}</a>"
                f"<div class='muted'>{html.escape(match.get('originalFileName') or '')}</div></td>"
                f"<td>{float(match['distance']):.4f}<div class='muted'>similarity {float(match['similarity']):.4f}</div></td>"
                f"<td>{name or '<span class=\"muted\">unnamed</span>'}</td>"
                f"<td class='path'>{html.escape(match['originalHostPath'])}</td>"
                "</tr>"
            )
        table = (
            "<table><thead><tr><th></th><th>Asset</th><th>Distance</th><th>Person</th><th>Original path</th></tr></thead>"
            + "<tbody>"
            + ("".join(rows) if rows else "<tr><td colspan='5'>No matches under the selected threshold.</td></tr>")
            + "</tbody></table>"
        )
        box = face.get("boundingBox", {})
        sections.append(
            "<div class='section'>"
            f"<h2>Query face {item['queryFace']}</h2>"
            f"<div class='muted'>Detection score: {float(face.get('score', 0)):.4f}; box: "
            f"{html.escape(str(box))}</div>"
            f"{table}</div>"
        )
    return "".join(sections)


class Handler(BaseHTTPRequestHandler):
    server_version = "ImmichReverseFaceSearch/1.0"

    def send_bytes(self, data, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, html_text, status=200):
        encoded = html_text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_thumb(self):
        query = parse_qs(urlparse(self.path).query)
        asset_id = query.get("assetId", [""])[0]
        try:
            uuid.UUID(asset_id)
        except ValueError:
            self.send_error(400, "Invalid assetId")
            return

        base_url = IMMICH_INTERNAL_URL if running_in_docker_service() else IMMICH_BASE_URL
        thumb_url = f"{base_url.rstrip('/')}/api/assets/{asset_id}/thumbnail?size=thumbnail"
        last_error = None
        api_keys = get_immich_api_keys()
        if not api_keys:
            self.send_error(500, "No Immich API keys found. Set IMMICH_API_KEYS or create immich_api_keys.local.txt.")
            return

        for api_key in api_keys:
            request = Request(thumb_url, headers={"x-api-key": api_key})
            try:
                with urlopen(request, timeout=30) as response:
                    content_type = response.headers.get("Content-Type", "image/jpeg")
                    self.send_bytes(response.read(), content_type)
                    return
            except Exception as exc:
                last_error = exc

        self.send_error(502, f"Could not fetch thumbnail from Immich: {last_error}")

    def do_GET(self):
        if self.path.startswith("/thumb?"):
            self.do_thumb()
            return
        query = parse_qs(urlparse(self.path).query)
        image_url = query.get("imageUrl", [""])[0]
        if image_url:
            tmp_path = None
            try:
                scope = query.get("scope", ["all"])[0]
                if scope not in {"all", "instagram"}:
                    scope = "all"
                threshold = float(query.get("threshold", [str(DEFAULT_THRESHOLD)])[0])
                limit = max(1, min(100, int(query.get("limit", [str(DEFAULT_LIMIT)])[0])))
                tmp_path = download_query_image(image_url)
                result = search_image(tmp_path, limit=limit, threshold=threshold, scope=scope)
                self.send_html(render_page(render_results(result)))
            except Exception as exc:
                self.send_html(render_page(f"<div class='section error'>{html.escape(str(exc))}</div>"), status=500)
            finally:
                if tmp_path is not None:
                    tmp_path.unlink(missing_ok=True)
            return
        self.send_html(render_page(""))

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            content_type = self.headers.get("Content-Type", "")
            body = self.rfile.read(content_length)
            message = BytesParser(policy=email_policy).parsebytes(
                f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
            )

            fields = {}
            files = {}
            for part in message.iter_parts():
                disposition = part.get("Content-Disposition", "")
                if not disposition:
                    continue
                name = part.get_param("name", header="content-disposition")
                filename = part.get_filename()
                if not name:
                    continue
                payload = part.get_payload(decode=True) or b""
                if filename:
                    files[name] = {"filename": filename, "payload": payload}
                else:
                    fields[name] = payload.decode(part.get_content_charset() or "utf-8", errors="replace")

            image_field = files.get("image")
            if image_field is None or not image_field.get("filename"):
                raise RuntimeError("No image file was uploaded")

            scope = fields.get("scope", "all")
            if scope not in {"all", "instagram"}:
                scope = "all"
            threshold = float(fields.get("threshold", str(DEFAULT_THRESHOLD)))
            limit = max(1, min(100, int(fields.get("limit", str(DEFAULT_LIMIT)))))

            suffix = Path(image_field["filename"]).suffix[:12] or ".jpg"
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(image_field["payload"])
                tmp_path = Path(tmp.name)
            try:
                result = search_image(tmp_path, limit=limit, threshold=threshold, scope=scope)
            finally:
                tmp_path.unlink(missing_ok=True)
            self.send_html(render_page(render_results(result)))
        except Exception as exc:
            self.send_html(render_page(f"<div class='section error'>{html.escape(str(exc))}</div>"), status=500)


def main():
    parser = argparse.ArgumentParser(description="Local reverse face search for Immich face embeddings")
    parser.add_argument("--host", default=DEFAULT_BIND)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--once", help="Search a single image path and print JSON")
    parser.add_argument("--scope", choices=["all", "instagram"], default="all")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    args = parser.parse_args()

    if args.once:
        result = search_image(Path(args.once), limit=args.limit, threshold=args.threshold, scope=args.scope)
        json.dump(result, sys.stdout, indent=2)
        print()
        return

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Reverse face search is running at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
