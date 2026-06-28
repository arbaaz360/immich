from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


Box = tuple[int, int, int, int]


@dataclass
class Candidate:
    face_id: str
    asset_id: str
    person_id: str | None
    person_name: str | None
    original_path: str
    host_path: Path
    image_width: int
    image_height: int
    face_box: Box
    faces_in_asset: int = 1
    group_key: str = "all"
    metrics: dict[str, float | int | str | None] = field(default_factory=dict)
    scores: dict[str, float] = field(default_factory=dict)
    flags: list[str] = field(default_factory=list)
    rank_score: float = 0.0
    output_crop: Path | None = None
    output_contact_image: Path | None = None
    vlm_note: str | None = None

    @property
    def face_width(self) -> int:
        return max(0, self.face_box[2] - self.face_box[0])

    @property
    def face_height(self) -> int:
        return max(0, self.face_box[3] - self.face_box[1])

    def as_row(self) -> dict[str, Any]:
        return {
            "group_key": self.group_key,
            "rank_score": round(self.rank_score, 6),
            "asset_id": self.asset_id,
            "face_id": self.face_id,
            "person_id": self.person_id or "",
            "person_name": self.person_name or "",
            "original_path": self.original_path,
            "host_path": str(self.host_path),
            "image_width": self.image_width,
            "image_height": self.image_height,
            "face_box": ",".join(str(v) for v in self.face_box),
            "faces_in_asset": self.faces_in_asset,
            "flags": ";".join(self.flags),
            "crop_path": str(self.output_crop or ""),
            "contact_image_path": str(self.output_contact_image or ""),
            "vlm_note": self.vlm_note or "",
            **{f"metric_{k}": v for k, v in sorted(self.metrics.items())},
            **{f"score_{k}": round(v, 6) for k, v in sorted(self.scores.items())},
        }


@dataclass
class RunContext:
    out_dir: Path
    crop_padding: float = 1.15
    write_crops: bool = True
    write_contact_sheets: bool = True

