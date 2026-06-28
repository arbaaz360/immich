# Profile Picture Picker

Ranks Immich image assets to find good profile-picture candidates.

The tool is built as a reusable pipeline:

1. `ImmichDbSource` loads existing Immich face boxes from Postgres.
2. `GroupStage` decides whether results are ranked together, per person, or per parent folder.
3. `FaceGeometryStage` scores face size, centering, vertical position, and solo/group penalties.
4. `RankStage` creates a DB-only preliminary rank.
5. `PreselectStage` keeps only the top candidates per group before touching original files on the HDD.
6. `ImageValidationStage` verifies the selected original files can be opened.
7. `SharpnessStage` scores blur using a pure-Python Laplacian variance on the face crop.
8. `RankStage` combines the final scores.
9. `CropExportStage` and `ContactSheetStage` produce inspection artifacts.
10. `OptionalOllamaVlmStage` can ask a local vision model to review the top few candidates.

Example for one Instagram username folder:

```powershell
python -m profile_picture_picker `
  --folder "X:\Immich\uploads\library\96e7f049-ce60-47a5-9548-a6ebefd14d85\taneesho" `
  --group-by all `
  --top-per-group 8
```

Example for a whole uploaded library, one winner per username folder:

```powershell
python -m profile_picture_picker `
  --folder "X:\Immich\uploads\library\96e7f049-ce60-47a5-9548-a6ebefd14d85" `
  --group-by parent-folder `
  --preselect-per-group 80 `
  --top-per-group 5
```

Example for one Immich album:

```powershell
python -m profile_picture_picker `
  --album-id "6ee9d7c3-3c73-4493-9c19-3c25d582ebfb" `
  --top-per-group 5
```

Optional local VLM review through Ollama:

```powershell
python -m profile_picture_picker `
  --folder "X:\Immich\uploads\library\96e7f049-ce60-47a5-9548-a6ebefd14d85\taneesho" `
  --ollama-model "llava:latest"
```

Outputs:

- `all_candidates.csv`: every scored face candidate.
- `top_candidates.csv`: top rows per group.
- `summary.txt`: compact per-group summary.
- `crops/`: top face crops.
- `contact_sheets/`: visual contact sheets for quick review.

## Local Cover Picker Service

Start the browser service:

```powershell
.\Start-ProfilePicturePicker.ps1
```

Then open:

```text
http://localhost:3111/album/<album-id>
```

The page shows the top 5 candidates and a `Set as cover` button for each one.
If `LM_STUDIO_MODEL` is set and LM Studio is serving an OpenAI-compatible vision model on
`http://localhost:1234`, the service asks that model to review the top candidates.

Immich's patched `index.html` adds a `Pick cover` button to album cards that opens this service.
