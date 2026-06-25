# Immich Local Setup

This repo stores the reproducible parts of the local Immich setup.

It intentionally does not store databases, Redis data, thumbnails, model cache, original media, backups, API keys, or logs.

## Current Layout

- Active database: `C:\Immich\database`
- Active Redis data: `C:\Immich\redis`
- Existing thumbnail cache: `C:\Immich\thumbnail-cache`
- Patch files: `C:\Immich\patches\immich-2.7.5`
- Immich compose directory: `X:\Immich`
- Original media: `X:\Immich\uploads\library` and `E:\` mounted read-only as `/mnt/e`

## Local Behavior Captured Here

- Photo detail view uses originals for `size=preview` image requests.
- Thumbnail requests prefer the SSD thumbnail cache at `/thumbnail-cache`.
- Smart Search, Face Detection, and OCR ML jobs use original image files instead of preview files.
- Thumbnail generation does not create preview files.
- Video thumbnail generation does not create preview files.
- Video transcoding is disabled by local patch; `Transcode Videos` will not queue video encode jobs, and already queued encode jobs skip.
- Reverse face search helper can upload a query image, extract an Immich face embedding, and search the local `face_search` table.

## Restore After C Drive Format

1. Install Docker Desktop and Git.
2. Make sure drive `X:` still contains `X:\Immich\uploads` and the original media.
3. Clone this repo.
4. Run PowerShell as your normal user:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup\Restore-LocalImmichSetup.ps1
```

5. Copy `.env.example` to `X:\Immich\.env` and fill in the real Immich API keys if you want the folder album creator containers and thumbnail proxy helper.
6. Start Immich:

```powershell
docker compose -f X:\Immich\docker-compose.yml up -d
```

The restore script backs up an existing `X:\Immich\docker-compose.yml` before replacing it, unless you run without `-InstallCompose`.

## Reverse Face Search

Start it with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Start-ReverseFaceSearch.ps1
```

Open:

```text
http://127.0.0.1:2299/
```

For thumbnail previews on the result page, provide an Immich API key in one of these ways:

- `IMMICH_API_KEYS` environment variable
- `scripts\immich_api_keys.local.txt`, one key per line
- A local `X:\Immich\docker-compose.yml` containing folder album creator `API_KEY` values

The helper only reads Immich data and does not modify the database.

## Important

These patches target Immich `2.7.5` compiled server files. After upgrading Immich, re-check the patch files before restarting with the same mounts.
