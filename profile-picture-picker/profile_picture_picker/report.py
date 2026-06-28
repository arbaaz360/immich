from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

from .models import Candidate


def write_reports(candidates: list[Candidate], out_dir: Path, top_per_group: int) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    all_rows = [candidate.as_row() for candidate in candidates]
    all_csv = out_dir / "all_candidates.csv"
    top_csv = out_dir / "top_candidates.csv"
    summary_txt = out_dir / "summary.txt"

    write_csv(all_csv, all_rows)

    top_rows = []
    for group, group_candidates in grouped_candidates(candidates).items():
        for rank, candidate in enumerate(sorted(group_candidates, key=lambda c: c.rank_score, reverse=True)[:top_per_group], 1):
            row = candidate.as_row()
            row["rank_in_group"] = rank
            top_rows.append(row)
    write_csv(top_csv, top_rows)

    summary_lines = [
        f"groups={len(grouped_candidates(candidates))}",
        f"candidates={len(candidates)}",
        f"top_per_group={top_per_group}",
        "",
    ]
    for group, group_candidates in grouped_candidates(candidates).items():
        best = max(group_candidates, key=lambda c: c.rank_score)
        summary_lines.append(
            f"{group}: best_score={best.rank_score:.4f} faces={len(group_candidates)} asset={best.asset_id} file={best.host_path}"
        )
    summary_txt.write_text("\n".join(summary_lines) + "\n", encoding="utf-8")

    return {"all_csv": all_csv, "top_csv": top_csv, "summary": summary_txt}


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    seen = set()
    for row in rows:
        for key in row:
            if key not in seen:
                fieldnames.append(key)
                seen.add(key)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def grouped_candidates(candidates: list[Candidate]) -> dict[str, list[Candidate]]:
    grouped: dict[str, list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        grouped[candidate.group_key].append(candidate)
    return dict(grouped)

