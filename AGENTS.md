# Working on this Immich deployment

Read `CUSTOMIZATION_CONTRACT.md` before changing Compose, database state, generated media behavior, album covers, or patched Immich files. Treat its invariants as user requirements, not implementation suggestions. Read `OPERATIONS.md` for the service inventory, schedules, ports, search variants, picker ownership, album pagination, and safe restart paths.

This repository targets the live deployment configured by `X:\Immich\docker-compose.yml`. Preserve unrelated working-tree changes. Before deploying a compiled web patch, regenerate and verify its `.gz` and `.br` siblings. Before changing storage or database state, make a rollback copy and verify live container mounts afterward.
