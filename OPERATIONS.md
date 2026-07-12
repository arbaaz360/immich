# Immich customization operations reference

This document is the operational map for the customized Immich deployment. Read it together with [`CUSTOMIZATION_CONTRACT.md`](CUSTOMIZATION_CONTRACT.md): the contract defines behavior that must not regress, while this file explains which service or patch provides that behavior and how to operate it.

Never commit API keys, database passwords, logs, databases, generated media, or original media. The reproducible Compose template uses placeholders; the live secrets remain only in `X:\Immich\docker-compose.yml` or its local environment file.

## Sources of truth

- Live Compose: `X:\Immich\docker-compose.yml`
- Reproducible Compose template: `docker/docker-compose.template.yml`
- Repository patches: `patches/immich-2.7.5`
- Live patches mounted into Immich: `C:\Immich\patches\immich-2.7.5`
- Current profile picker source: `profile-picture-picker`
- Current reverse face search source: `reverse-face-search`
- Album Smart Search currently exists only at `X:\Immich\album-smart-search`; it is not Compose-managed or restored from this repository.
- The older standalone cover picker at `X:\Immich\album-cover-picker` is legacy. Do not confuse it with the active `immich-profile-picture-picker` Compose service.

## Service inventory

| Component | Runtime and address | Starts automatically | Responsibility |
| --- | --- | --- | --- |
| `immich-server` | Compose, `http://localhost:2283` | Yes, `unless-stopped` | Immich API and patched web UI |
| `immich-microservices` | Compose, internal only | Yes, `unless-stopped` | Background job processing with the same server-side media patches |
| `immich-ml` | Compose, internal port 3003 | Yes, `unless-stopped` | CUDA-backed face, CLIP and OCR inference; model cache is on C |
| `database` / `immich-db` | Compose, internal port 5432 | Yes, `unless-stopped` | Postgres on `C:\Immich\database`, including custom policy tables/triggers |
| `cache` / `immich-cache` | Compose, internal port 6379 | Yes, `unless-stopped` | Valkey job/runtime state on `C:\Immich\redis` |
| `immich-reverse-face-search` | Compose, `http://localhost:2299` | Yes, `unless-stopped` | Upload/right-click query image, create a face embedding through Immich ML, and search `face_search` |
| `immich-profile-picture-picker` | Compose, `http://localhost:3111` | Yes, `unless-stopped` | Interactive cover picker, hover candidates, bulk picker, and automatic cover worker |
| Three `immich-folder-album-creator-*` services | Compose, no host port | Yes, `unless-stopped` | One user/library root per service; synchronize first-level folders to albums every five minutes |
| Album Smart Search | Manual Node process, `http://localhost:3099` | No | Filter album names, select an album, then run Immich semantic search restricted to that album |
| Album Sentinel browser extension | Browser extension | When enabled in Chrome/Brave | Check Instagram usernames against albums, right-click reverse face search, and reliable image copy |

Check Compose state without changing anything:

```powershell
docker compose -f X:\Immich\docker-compose.yml ps
```

Follow logs for a specific service:

```powershell
docker compose -f X:\Immich\docker-compose.yml logs --tail 200 -f immich-profile-picture-picker
```

Recreate only a changed service instead of restarting the entire stack:

```powershell
docker compose -f X:\Immich\docker-compose.yml up -d --build --force-recreate immich-profile-picture-picker
```

## Folder to album flow

There are three Folder Album Creator containers, one for each configured user/library root. Each mounts `X:\Immich\uploads\library` read-only as `/external`, runs immediately at container start, and then runs on `*/5 * * * *` in `Asia/Kolkata`. `ALBUM_LEVELS=1` means first-level folders under each configured root become albums. `SYNC_MODE=2` keeps album membership synchronized according to the helper's mode.

The helper can create albums and add assets only after Immich has discovered those assets in the relevant external library. It does not scan originals into Immich, generate thumbnails, run face jobs, or select covers itself.

Album creation and cover selection are deliberately separate:

1. Immich discovers assets during an external-library scan, or the frontend uploads assets into a new album.
2. Folder Album Creator creates/synchronizes folder-backed albums where applicable.
3. Database triggers create an `album_cover_policy` row in `pending` state for every newly created album, regardless of creation route.
4. The picker service polls every 60 seconds. It considers at most three pending albums per pass after the five-minute grace period.
5. Once an eligible image has its thumbnail and face data, the worker may set it as the cover and record `automatic`.
6. A manual cover choice through Immich or the picker records `locked`; automatic and bulk paths must then leave it unchanged.

Albums with no qualifying face-based image may remain pending and coverless. Folder synchronization every five minutes does not imply that thumbnails, face data, or a cover will be ready within five minutes.

## Reverse face search

The `Face` button injected into the Immich UI opens `http://localhost:2299/`. The service accepts an uploaded image, uses the internal Immich ML service to obtain a face embedding, queries the local `face_search` table, and renders links/thumbnails through Immich. It is a read-only search helper and does not alter asset or face records.

Album Sentinel also adds **Search this face in Immich** to an image's browser context menu and submits the selected image to this service. Blob-backed browser images are captured by the extension before submission.

If the page is unavailable, check `immich-reverse-face-search`, `immich-ml`, `immich-server`, and `database`. Rebuild/recreate the helper after changing `reverse-face-search`.

## Picker, auto-picker, and hover UI

The active service on port 3111 has four related paths:

- `Pick cover` opens the full per-album picker. It reads existing face boxes, opens shortlisted originals, ranks framing, and shows the top five candidates.
- Clicking a candidate is a manual selection and must lock the album.
- `/bulk-start` and `/bulk-status` provide a bulk run, but locked covers remain protected.
- The daemon worker performs automatic cover selection using the interval, grace period, and batch size described above.

Album-card hover is a lighter path: the patched `web/index.html` calls the fast database-only endpoint and displays existing Immich thumbnails. The panel is sized to its visible results, placed near the card, stays open while traversing the pointer gap, and closes only after a 1.5-second leave delay. Hovering the panel cancels that pending close.

Picker inspection output belongs on the SSD at `C:\Immich\profile-picture-picker-runs`. Original images remain on X/E and are opened read-only by the picker.

## Search customizations

Three different search features must not be conflated:

- Standard Immich Smart Search remains part of Immich. Its patched ML job path reads original images because previews are disabled.
- Reverse face search on port 2299 searches face embeddings using an uploaded image.
- Album Smart Search on port 3099 is a separate companion UI. It loads albums, filters them by album name, selects one album, and sends a semantic query to Immich restricted to that album. It can restrict results to images and control the requested result count. It normally reuses the browser's Immich session, with an API-key field as a fallback.

Album Smart Search is currently manual and deployed-only:

```powershell
Set-Location X:\Immich\album-smart-search
.\start.ps1
```

Do not describe port 3099 as a background service until it has been added to Compose or another explicit startup mechanism. Its implementation should be copied into this repository before treating it as reproducible.

## Album search and pagination UI

The compiled album-list patch in `patches/immich-2.7.5/web/_app/immutable/chunks/Cv3joWmC2.js` adds client-side pagination after Immich's album name/description filter is applied. The companion controls are injected by `web/index.html`.

The same control bar includes a persistent minimum album-size filter. It is enabled by default, uses `Images` with a minimum of `30`, and can switch quickly among `Images + video`, `Images`, and `Video`. Its settings use these browser `localStorage` keys:

- `immichAlbumCountFilterEnabled`
- `immichAlbumCountFilterMode`
- `immichAlbumCountFilterMinimum`

The active picker exposes `/api/album-media-counts`, which counts active image/video memberships directly from Postgres. The early `web/index.html` fetch wrapper applies those counts to Immich's album response before the compiled album component performs its normal name/description search and pagination. If port 3111 is unavailable, filtering fails open so albums remain accessible.

- Default page size: 100 albums.
- Allowed range in the compiled patch: 24 through 500.
- The selected page size is saved in browser `localStorage` under `immichAlbumPageSize`.
- Changing page size reloads the page; page navigation updates the displayed slice.
- Pagination operates on the filtered album collection, so search/filter totals and page counts must remain consistent.
- Sorting and grouping apply to the albums on the current page. This is client-side UI pagination, not an API/database pagination change.

Because this is a compiled-chunk patch, an Immich upgrade can silently invalidate it. Revalidate album filtering, page controls, persisted page size, grouping, sorting, and both grid/list views after any upgrade.

## Preview-free jobs and storage

Preview generation is intentionally absent from every customized flow. The small asset thumbnail, thumbhash, and original are the expected image artifacts; a converted full-size file is allowed only when browser compatibility requires it.

- Missing-only thumbnail jobs ignore absent preview rows.
- Face Detection, Smart Search, and OCR use originals.
- Album covers and hover cards display small thumbnails; the full picker may inspect shortlisted originals.
- Do not add preview readiness as a prerequisite for auto covers, folder albums, search, person thumbnails, or job selection.
- Avoid forced `All` jobs unless diagnosing a specific issue. Folder scans and album creation do not require rerunning all thumbnails or all face jobs.

Original media stays on X/E. Postgres, Valkey, thumbnails, profiles, encoded video, backups, model cache, helper output, and thumbnail cache stay on C. Verify actual mounts after Compose edits:

```powershell
docker inspect immich-server immich-microservices immich-db immich-cache
```

## Patch and deployment discipline

For a web HTML change, update the repository and live copies, regenerate `index.html.gz` and `index.html.br`, verify each decompresses byte-for-byte to `index.html`, and recreate `immich-server`. For a compiled chunk change, do the same for the chunk's `.gz` and `.br` siblings.

For server patch changes, update both `patches/immich-2.7.5` and `C:\Immich\patches\immich-2.7.5`, then recreate both `immich-server` and `immich-microservices` because both mount the patched job/service files.

Before database, storage, or live Compose changes, make a dated rollback copy. Preserve unrelated live settings and never replace secret placeholders in the repository with live values.
