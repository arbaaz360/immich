from __future__ import annotations

import base64
import json
import math
import re
import urllib.request
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .models import Box, Candidate, RunContext
from .pipeline import Stage


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def bell(value: float, ideal: float, tolerance: float) -> float:
    distance = abs(value - ideal)
    return clamp(1.0 - (distance / tolerance), 0.0, 1.0)


def expanded_box(box: Box, width: int, height: int, scale: float) -> Box:
    x1, y1, x2, y2 = box
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    bw = max(1.0, (x2 - x1) * scale)
    bh = max(1.0, (y2 - y1) * scale)
    return (
        int(clamp(cx - bw / 2.0, 0, width - 1)),
        int(clamp(cy - bh / 2.0, 0, height - 1)),
        int(clamp(cx + bw / 2.0, 1, width)),
        int(clamp(cy + bh / 2.0, 1, height)),
    )


def upper_body_box(box: Box, width: int, height: int, aspect_ratio: float = 0.8) -> Box:
    x1, y1, x2, y2 = box
    face_w = max(1.0, x2 - x1)
    face_h = max(1.0, y2 - y1)
    cx = (x1 + x2) / 2.0

    top = y1 - face_h * 0.95
    bottom = y2 + face_h * 3.15
    crop_h = max(face_h * 4.4, bottom - top)
    crop_w = max(face_w * 3.6, crop_h * aspect_ratio)

    crop_h = min(crop_h, float(height))
    crop_w = min(crop_w, float(width))

    crop_top = clamp(top, 0, height - crop_h)
    crop_left = clamp(cx - crop_w / 2.0, 0, width - crop_w)
    return (
        int(crop_left),
        int(crop_top),
        int(crop_left + crop_w),
        int(crop_top + crop_h),
    )


class GroupStage(Stage):
    name = "group"

    def __init__(self, group_by: str) -> None:
        if group_by not in {"all", "person", "parent-folder"}:
            raise ValueError("group_by must be one of: all, person, parent-folder")
        self.group_by = group_by

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        for candidate in candidates:
            if self.group_by == "person":
                candidate.group_key = candidate.person_id or "unknown-person"
            elif self.group_by == "parent-folder":
                candidate.group_key = candidate.host_path.parent.name
            else:
                candidate.group_key = "all"
        return candidates


class ImageValidationStage(Stage):
    name = "image_validation"

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        valid: list[Candidate] = []
        for candidate in candidates:
            if not candidate.host_path.exists():
                candidate.flags.append("missing_file")
                continue
            try:
                with Image.open(candidate.host_path) as img:
                    width, height = ImageOps.exif_transpose(img).size
                candidate.metrics["actual_width"] = width
                candidate.metrics["actual_height"] = height
                if width != candidate.image_width or height != candidate.image_height:
                    candidate.flags.append("db_dimension_mismatch")
            except Exception as exc:
                candidate.flags.append(f"image_open_failed:{type(exc).__name__}")
                continue
            valid.append(candidate)
        return valid


class FaceGeometryStage(Stage):
    name = "face_geometry"

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        for c in candidates:
            img_w = max(1, c.image_width)
            img_h = max(1, c.image_height)
            face_w = max(1, c.face_width)
            face_h = max(1, c.face_height)
            cx = (c.face_box[0] + c.face_box[2]) / 2.0
            cy = (c.face_box[1] + c.face_box[3]) / 2.0

            face_height_ratio = face_h / img_h
            face_width_ratio = face_w / img_w
            center_x_error = abs((cx / img_w) - 0.5)
            center_y = cy / img_h
            face_aspect = face_w / face_h
            below_face_ratio = max(0.0, (img_h - c.face_box[3]) / img_h)

            c.metrics.update(
                {
                    "face_height_ratio": round(face_height_ratio, 6),
                    "face_width_ratio": round(face_width_ratio, 6),
                    "face_center_x_error": round(center_x_error, 6),
                    "face_center_y": round(center_y, 6),
                    "face_aspect": round(face_aspect, 6),
                    "below_face_ratio": round(below_face_ratio, 6),
                }
            )
            c.scores["face_size"] = bell(face_height_ratio, ideal=0.15, tolerance=0.13)
            c.scores["face_centering"] = bell(center_x_error, ideal=0.0, tolerance=0.32)
            c.scores["face_vertical_position"] = bell(center_y, ideal=0.28, tolerance=0.24)
            c.scores["face_aspect"] = bell(face_aspect, ideal=0.78, tolerance=0.45)
            c.scores["upper_body_room"] = clamp((below_face_ratio - 0.24) / 0.34, 0.0, 1.0)
            c.scores["not_closeup"] = clamp((0.32 - face_height_ratio) / 0.16, 0.0, 1.0)
            c.scores["solo"] = 1.0 if c.faces_in_asset == 1 else 0.72 if c.faces_in_asset == 2 else 0.35
            if face_height_ratio < 0.045:
                c.flags.append("face_too_small")
            if face_height_ratio > 0.26 or below_face_ratio < 0.34:
                c.flags.append("too_close_for_cover")
            if c.faces_in_asset > 2:
                c.flags.append("many_faces")
        return candidates


class SharpnessStage(Stage):
    name = "sharpness"

    def __init__(self, max_side: int = 256) -> None:
        self.max_side = max_side

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        for c in candidates:
            try:
                with Image.open(c.host_path) as img:
                    img = ImageOps.exif_transpose(img).convert("L")
                    crop = img.crop(expanded_box(c.face_box, img.width, img.height, 1.45))
                    crop.thumbnail((self.max_side, self.max_side))
                    variance = laplacian_variance(crop)
            except Exception as exc:
                c.flags.append(f"sharpness_failed:{type(exc).__name__}")
                variance = 0.0

            c.metrics["sharpness_laplacian_var"] = round(variance, 3)
            c.scores["sharpness"] = clamp(math.log10(variance + 1.0) / 3.0, 0.0, 1.0)
            if variance < 45:
                c.flags.append("possibly_blurry")
        return candidates


class CropExportStage(Stage):
    name = "crop_export"

    def __init__(self, limit_per_group: int = 12) -> None:
        self.limit_per_group = limit_per_group

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        if not context.write_crops:
            return candidates
        crops_dir = context.out_dir / "crops"
        crops_dir.mkdir(parents=True, exist_ok=True)

        for c in top_per_group(candidates, self.limit_per_group):
            try:
                with Image.open(c.host_path) as img:
                    img = ImageOps.exif_transpose(img).convert("RGB")
                    box = upper_body_box(c.face_box, img.width, img.height)
                    crop = img.crop(box)
                    out = crops_dir / f"{safe_name(c.group_key)}__{c.asset_id}__{c.face_id}.jpg"
                    crop.save(out, quality=92)
                    c.output_crop = out
            except Exception as exc:
                c.flags.append(f"crop_failed:{type(exc).__name__}")
        return candidates


class RankStage(Stage):
    name = "rank"

    def __init__(self, weights: dict[str, float] | None = None) -> None:
        self.weights = weights or {
            "face_size": 1.25,
            "face_centering": 1.15,
            "face_vertical_position": 0.9,
            "face_aspect": 0.65,
            "upper_body_room": 1.75,
            "not_closeup": 1.5,
            "solo": 1.2,
            "sharpness": 1.0,
        }

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        total_weight = sum(self.weights.values()) or 1.0
        for c in candidates:
            score = 0.0
            for name, weight in self.weights.items():
                score += c.scores.get(name, 0.0) * weight
            c.rank_score = score / total_weight
        return sorted(candidates, key=lambda c: (c.group_key, -c.rank_score))


class PreselectStage(Stage):
    name = "preselect"

    def __init__(self, per_group: int) -> None:
        self.per_group = per_group

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        if self.per_group <= 0:
            return candidates
        return sorted(top_per_group(candidates, self.per_group), key=lambda c: (c.group_key, -c.rank_score))


class ContactSheetStage(Stage):
    name = "contact_sheet"

    def __init__(self, top_per_group_count: int = 8, thumb_size: tuple[int, int] = (260, 340)) -> None:
        self.top_per_group_count = top_per_group_count
        self.thumb_size = thumb_size

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        if not context.write_contact_sheets:
            return candidates
        sheets_dir = context.out_dir / "contact_sheets"
        sheets_dir.mkdir(parents=True, exist_ok=True)

        grouped: dict[str, list[Candidate]] = defaultdict(list)
        for c in candidates:
            grouped[c.group_key].append(c)

        for group, group_candidates in grouped.items():
            selected = sorted(group_candidates, key=lambda c: c.rank_score, reverse=True)[: self.top_per_group_count]
            if not selected:
                continue
            sheet = self._make_sheet(selected, group)
            out = sheets_dir / f"{safe_name(group)}.jpg"
            sheet.save(out, quality=90)
            for c in selected:
                c.output_contact_image = out
        return candidates

    def _make_sheet(self, candidates: list[Candidate], group: str) -> Image.Image:
        cell_w, cell_h = self.thumb_size
        cols = min(4, max(1, len(candidates)))
        rows = math.ceil(len(candidates) / cols)
        header_h = 42
        label_h = 52
        sheet = Image.new("RGB", (cols * cell_w, header_h + rows * (cell_h + label_h)), "white")
        draw = ImageDraw.Draw(sheet)
        draw.text((12, 12), f"{group} - top {len(candidates)} candidates", fill=(20, 20, 20))
        for idx, c in enumerate(candidates):
            col = idx % cols
            row = idx // cols
            x = col * cell_w
            y = header_h + row * (cell_h + label_h)
            try:
                with Image.open(c.host_path) as img:
                    img = ImageOps.exif_transpose(img).convert("RGB")
                    box = upper_body_box(c.face_box, img.width, img.height)
                    thumb = img.crop(box)
                    thumb.thumbnail((cell_w, cell_h))
                    px = x + (cell_w - thumb.width) // 2
                    py = y + (cell_h - thumb.height) // 2
                    sheet.paste(thumb, (px, py))
                    draw.rectangle((px, py, px + thumb.width - 1, py + thumb.height - 1), outline=(210, 210, 210))
            except Exception:
                draw.rectangle((x + 8, y + 8, x + cell_w - 8, y + cell_h - 8), outline=(220, 80, 80))
            label = f"#{idx + 1} score={c.rank_score:.3f}\nfaces={c.faces_in_asset} sharp={c.metrics.get('sharpness_laplacian_var', '')}"
            draw.text((x + 8, y + cell_h + 6), label, fill=(20, 20, 20))
        return sheet


class OptionalOllamaVlmStage(Stage):
    name = "optional_ollama_vlm"

    def __init__(self, model: str, top_n: int = 3, endpoint: str = "http://localhost:11434/api/chat") -> None:
        self.model = model
        self.top_n = top_n
        self.endpoint = endpoint

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        grouped: dict[str, list[Candidate]] = defaultdict(list)
        for c in candidates:
            grouped[c.group_key].append(c)

        for group, group_candidates in grouped.items():
            top = sorted(group_candidates, key=lambda c: c.rank_score, reverse=True)[: self.top_n]
            if not top:
                continue
            prompt = (
                "Pick the best album cover candidate. Prefer a clear visible face with upper body at least to the chest, "
                "good lighting, sharp focus, and a solo subject. Reject tight mugshot-like face close-ups. "
                "Answer with only the candidate number and a short reason."
            )
            images = []
            for c in top:
                image_path = c.output_crop or c.host_path
                images.append(base64.b64encode(Path(image_path).read_bytes()).decode("ascii"))
            payload = {
                "model": self.model,
                "stream": False,
                "messages": [{"role": "user", "content": prompt, "images": images}],
            }
            try:
                request = urllib.request.Request(
                    self.endpoint,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=120) as response:
                    data = json.loads(response.read().decode("utf-8"))
                note = data.get("message", {}).get("content", "").strip()
                if note:
                    selected = selected_candidate_from_note(top, note)
                    selected.vlm_note = note
                    selected.scores["vlm_reviewed"] = 1.0
                    selected.rank_score += 0.03
            except Exception as exc:
                for c in top:
                    c.flags.append(f"vlm_failed:{type(exc).__name__}")
        return sorted(candidates, key=lambda c: (c.group_key, -c.rank_score))


class OptionalLmStudioVlmStage(Stage):
    name = "optional_lm_studio_vlm"

    def __init__(
        self,
        model: str,
        top_n: int = 3,
        endpoint: str = "http://localhost:1234/v1/chat/completions",
    ) -> None:
        self.model = model
        self.top_n = top_n
        self.endpoint = endpoint

    def run(self, candidates: list[Candidate], context: RunContext) -> list[Candidate]:
        grouped: dict[str, list[Candidate]] = defaultdict(list)
        for c in candidates:
            grouped[c.group_key].append(c)

        for group_candidates in grouped.values():
            top = sorted(group_candidates, key=lambda c: c.rank_score, reverse=True)[: self.top_n]
            if not top:
                continue
            content = [
                {
                    "type": "text",
                    "text": (
                        "These are candidate album cover/profile pictures. Pick the best one. "
                        "Prefer a clear face with upper body at least to the chest, sharp focus, and pleasing composition. "
                        "Do not pick tight mugshot-like close-ups where only the face fills the crop. "
                        "Answer with only the candidate number and one short reason."
                    ),
                }
            ]
            for index, candidate in enumerate(top, 1):
                image_path = candidate.output_crop or candidate.host_path
                data_url = "data:image/jpeg;base64," + base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
                content.append({"type": "text", "text": f"Candidate {index}"})
                content.append({"type": "image_url", "image_url": {"url": data_url}})
            payload = {
                "model": self.model,
                "messages": [{"role": "user", "content": content}],
                "temperature": 0.1,
                "max_tokens": 80,
            }
            try:
                request = urllib.request.Request(
                    self.endpoint,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=180) as response:
                    data = json.loads(response.read().decode("utf-8"))
                note = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                if note:
                    selected = selected_candidate_from_note(top, note)
                    selected.vlm_note = note
                    selected.scores["lm_studio_reviewed"] = 1.0
                    selected.rank_score += 0.03
            except Exception as exc:
                for c in top:
                    c.flags.append(f"lm_studio_vlm_failed:{type(exc).__name__}")
        return sorted(candidates, key=lambda c: (c.group_key, -c.rank_score))


def laplacian_variance(image: Image.Image) -> float:
    pixels = image.load()
    width, height = image.size
    if width < 3 or height < 3:
        return 0.0
    values: list[float] = []
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            center = pixels[x, y] * 4
            value = center - pixels[x - 1, y] - pixels[x + 1, y] - pixels[x, y - 1] - pixels[x, y + 1]
            values.append(float(value))
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return sum((v - mean) ** 2 for v in values) / len(values)


def selected_candidate_from_note(candidates: list[Candidate], note: str) -> Candidate:
    lowered = note.lower()
    for pattern in (r"candidate\s*#?\s*(\d+)", r"^#?\s*(\d+)"):
        match = re.search(pattern, lowered)
        if match:
            index = int(match.group(1)) - 1
            if 0 <= index < len(candidates):
                return candidates[index]
    return candidates[0]


def top_per_group(candidates: list[Candidate], count: int) -> list[Candidate]:
    grouped: dict[str, list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        grouped[candidate.group_key].append(candidate)
    selected: list[Candidate] = []
    for group_candidates in grouped.values():
        selected.extend(sorted(group_candidates, key=lambda c: c.rank_score, reverse=True)[:count])
    return selected


def safe_name(value: str) -> str:
    keep = []
    for char in value:
        keep.append(char if char.isalnum() or char in "._-" else "_")
    return "".join(keep).strip("._")[:120] or "group"
