# Immich customization contract

This file records the intended behavior of the local Immich deployment. Read it before making changes so a local fix does not silently undo another customization.

## Version and deployment

- Immich server and machine-learning images are pinned to `2.7.5`.
- Live Compose file: `X:\Immich\docker-compose.yml`.
- Reproducible Compose template: `docker/docker-compose.template.yml`.
- Live compiled patches: `C:\Immich\patches\immich-2.7.5`.
- Repository copies: `patches/immich-2.7.5`.
- Do not pull or upgrade Immich without revalidating every compiled patch against the new version.

## Storage invariants

- Originals stay on HDD storage: managed uploads and external libraries under `X:\Immich\uploads`, plus the read-only E-drive external library.
- Generated/runtime data belongs on the C-drive SSD: Postgres, Redis, model cache, thumbnails, profile images, encoded video, backups, helper output, and thumbnail cache.
- The broad `X:\Immich\uploads:/data` mount is intentionally overlaid by specific C-drive mounts for generated subdirectories.
- Preserve original files and timestamps by default. Use reversible quarantine or staged moves instead of deletion.

## Thumbnail-plus-original media model

- Preview generation is deliberately disabled.
- Missing-only thumbnail selection must never treat a missing preview as work.
- Browser-supported image preview requests serve the original.
- Thumbnail jobs generate the small thumbnail and thumbhash, plus a converted full-size file only when required for browser compatibility.
- Face Detection, Smart Search, and OCR consume originals rather than previews.
- Person thumbnails use originals for images and small asset thumbnails for videos. They may use `/thumbnail-cache` as the SSD fallback.
- Do not reintroduce preview dependencies into job selection, person thumbnails, or album-cover logic.
- Do not run forced `All` jobs casually; missing-only runs are the normal maintenance path.

## Invalid-media handling

- Proven missing, zero-byte, truncated, or undecodable originals are recorded by original path in `invalid_media_path`.
- Surviving matching asset rows are marked offline. Thumbnail and face selectors exclude offline assets and excluded paths.
- Damaged files are preserved outside scanned roots, not deleted:
  - `X:\Immich\invalid-media-quarantine`
  - `E:\ImmichInvalidMediaQuarantine`
- The E-drive library exclusion patterns must continue to include `**/ImmichInvalidMediaQuarantine/**`.
- Durable audit and restoration artifacts live in the corresponding `invalid_media_repair_*` workspace folder.

## Album-cover policy

- Cover candidates are images only; videos and video thumbnails are excluded.
- Albums created through the frontend and Folder Album Creator receive the same database policy.
- New albums begin `pending`. The automatic worker waits five minutes and then polls for eligible thumbnail-plus-face candidates.
- An automatic choice records `automatic` in `album_cover_policy`.
- A later manual cover selection records `locked` and must never be overwritten by automatic or bulk processing.
- Existing albums that already had covers when the policy was installed were baselined as locked.
- Albums without a usable face candidate may remain pending and coverless. Do not claim every non-empty album has a cover unless a non-face fallback has been implemented and verified.

## Album hover UI

- Album hover candidates use the fast DB-only ranking endpoint and Immich thumbnail URLs.
- The panel width follows the visible candidate count; it must not reserve a five-column width for one result.
- The panel should sit close to its album card with a traversable pointer path.
- Mouse leave uses a 1.5-second grace period. Hovering the panel cancels closure.
- `Pick cover` opens the full picker; selecting a candidate is a manual action and locks the album.
- After editing `web/index.html`, regenerate `index.html.gz` and `index.html.br`, verify both decompress byte-for-byte to the HTML, and recreate `immich-server`.

## Expected custom database objects

- `album_cover_policy` and its album insert/update triggers implement automatic/manual cover state.
- `invalid_media_path` provides durable path-based exclusion even if an asset is deleted and rediscovered under a new ID.
- `invalid_media_repair` is an asset-ID audit ledger where the referenced asset row still exists.
- Immich may report schema drift because these are intentional custom objects. Do not remove them merely to silence that warning.

## Verification checklist

After relevant changes, verify:

1. `immich-server`, `immich-microservices`, database, cache, and ML containers are healthy.
2. Live mounts still place generated data on C and originals on X/E.
3. Missing-only thumbnail generation does not queue assets merely because previews are absent.
4. No online, visible, non-excluded asset lacks a thumbnail/thumbhash.
5. No assigned album cover points to an asset without a thumbnail.
6. A new album transitions `pending -> automatic`, then a manual change transitions it to `locked` and blocks later automatic writes.
7. The hover panel can be reached without closing and compressed web assets match the source HTML.

