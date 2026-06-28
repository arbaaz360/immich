from __future__ import annotations

import argparse
from datetime import datetime
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
    OptionalOllamaVlmStage,
    PreselectStage,
    RankStage,
    SharpnessStage,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Rank Immich photos for profile-picture suitability using reusable pipeline stages."
    )
    parser.add_argument("--folder", help="Host folder under X:\\Immich\\uploads to scan recursively.")
    parser.add_argument("--album-id", help="Immich album id to scan.")
    parser.add_argument("--library-id", help="Immich library id to scan.")
    parser.add_argument("--person-id", help="Only scan one Immich person id.")
    parser.add_argument("--limit", type=int, help="Maximum DB rows to load, useful for tests.")
    parser.add_argument(
        "--group-by",
        choices=["all", "person", "parent-folder"],
        default="all",
        help="How to produce separate winners. Use parent-folder for Instagram username folders.",
    )
    parser.add_argument("--top-per-group", type=int, default=8, help="How many top candidates to export per group.")
    parser.add_argument(
        "--preselect-per-group",
        type=int,
        default=80,
        help="DB-only candidates kept per group before opening image files for sharpness/crops. Use 0 to disable.",
    )
    parser.add_argument("--out", type=Path, help="Output folder. Defaults to profile_picture_runs/<timestamp>.")
    parser.add_argument("--no-crops", action="store_true", help="Do not write face crops.")
    parser.add_argument("--no-contact-sheets", action="store_true", help="Do not write contact-sheet images.")
    parser.add_argument("--ollama-model", help="Optional local vision model in Ollama, for final review of top candidates.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.folder and not args.album_id and not args.library_id and not args.person_id:
        raise SystemExit("Provide at least one scope: --folder, --album-id, --library-id, or --person-id.")

    out_dir = args.out or Path("profile_picture_runs") / datetime.now().strftime("%Y%m%d_%H%M%S")
    context = RunContext(
        out_dir=out_dir,
        write_crops=not args.no_crops,
        write_contact_sheets=not args.no_contact_sheets,
    )

    source = ImmichDbSource()
    candidates = source.load_faces(
        folder=args.folder,
        album_id=args.album_id,
        library_id=args.library_id,
        person_id=args.person_id,
        limit=args.limit,
    )
    print(f"Loaded {len(candidates)} face candidates")

    stages = [
        GroupStage(args.group_by),
        FaceGeometryStage(),
        RankStage(),
        PreselectStage(args.preselect_per_group),
        ImageValidationStage(),
        SharpnessStage(),
        RankStage(),
        CropExportStage(limit_per_group=args.top_per_group),
        ContactSheetStage(top_per_group_count=args.top_per_group),
    ]
    if args.ollama_model:
        stages.append(OptionalOllamaVlmStage(args.ollama_model, top_n=min(args.top_per_group, 3)))

    ranked = Pipeline(stages).run(candidates, context)
    reports = write_reports(ranked, out_dir, top_per_group=args.top_per_group)

    print(f"Valid candidates: {len(ranked)}")
    print(f"Output: {out_dir.resolve()}")
    for name, path in reports.items():
        print(f"{name}: {path.resolve()}")
    return 0
