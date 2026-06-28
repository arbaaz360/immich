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

## Update Policy

This setup is intentionally pinned. Immich server and ML images use `v2.7.5`, and helper images are pinned instead of using floating `latest` tags. Do not run `docker compose pull` unless you are intentionally upgrading and re-checking the local patches.

## Local Behavior Captured Here

- Photo detail view uses originals for `size=preview` image requests.
- Thumbnail requests prefer the SSD thumbnail cache at `/thumbnail-cache`.
- Smart Search, Face Detection, and OCR ML jobs use original image files instead of preview files.
- Thumbnail generation does not create preview files.
- Video thumbnail generation does not create preview files.
- Video transcoding is disabled by local patch; `Transcode Videos` will not queue video encode jobs, and already queued encode jobs skip.
- Reverse face search runs as a Docker Compose service on `http://localhost:2299/`.
- Immich web has a small `Face` button that opens reverse face search in a new tab.
- Reverse face search can upload a query image, extract an Immich face embedding, and search the local `face_search` table.
- Profile picture picker runs as a Docker Compose service on `http://localhost:3111/` and `http://samurai.local:3111/`.
- Immich album cards have a `Pick cover` button that opens the picker for that album, and hovering an album card shows the top 5 cover candidates using Immich thumbnail URLs for fast display.
- The picker ranks image assets by visible face plus upper-body framing, shows the top 5 candidates, and can set the selected asset as the album cover.

## Restore After C Drive Format

1. Install Docker Desktop and Git.
2. Make sure drive `X:` still contains `X:\Immich\uploads` and the original media.
3. Clone this repo.
4. Run PowerShell as your normal user:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup\Restore-LocalImmichSetup.ps1
```

5. Copy `.env.example` to `X:\Immich\.env` and fill in the real Immich API keys if you want the folder album creator containers and thumbnail proxy helper. Optionally set `LM_STUDIO_MODEL` if you want the profile picker to ask LM Studio to review the top candidates.
6. Start Immich:

```powershell
docker compose -f X:\Immich\docker-compose.yml up -d
```

The restore script backs up an existing `X:\Immich\docker-compose.yml` before replacing it, unless you run without `-InstallCompose`.

## Reverse Face Search

It starts with Docker Compose as `immich-reverse-face-search`.

Open it directly with:

```text
http://localhost:2299/
```

Or click the `Face` button in the bottom-right of the Immich web UI.

The old standalone PowerShell launcher is still included for manual/debug use:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Start-ReverseFaceSearch.ps1
```

For thumbnail previews on the result page, provide an Immich API key in one of these ways:

- `IMMICH_API_KEYS` environment variable
- `scripts\immich_api_keys.local.txt`, one key per line
- A local `X:\Immich\docker-compose.yml` containing folder album creator `API_KEY` values

The helper only reads Immich data and does not modify the database.

## Profile Picture Picker

It starts with Docker Compose as `immich-profile-picture-picker`.

Open it directly with:

```text
http://localhost:3111/
http://samurai.local:3111/
```

Or click `Pick cover` on an album card in Immich. The picker:

- Reads existing Immich face boxes from Postgres.
- Opens only shortlisted original image files from `/data` or `/external`.
- Prefers clear album-cover framing with face plus upper body/chest, not tight mugshot crops.
- Shows top 5 candidates.
- Updates `album.albumThumbnailAssetId` when you click `Set as cover`.
- Can bulk-set the top candidate for the configured library via `http://localhost:3111/bulk-start`, with progress at `http://localhost:3111/bulk-status`.
- Hover previews use a fast DB-only ranking path and Immich thumbnails; the full picker page still opens originals to create upper-body crops and CSV reports.

Generated service crops and CSVs are stored in:

```text
C:\Immich\profile-picture-picker-runs
```

If LM Studio is running on the host, set these in `X:\Immich\.env`:

```text
LM_STUDIO_MODEL=qwen2-vl-7b-instruct
LM_STUDIO_URL=http://host.docker.internal:1234/v1/chat/completions
```

## Important

These patches target Immich `2.7.5` compiled server files. After upgrading Immich, re-check the patch files before restarting with the same mounts.
