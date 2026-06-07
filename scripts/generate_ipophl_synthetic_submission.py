#!/usr/bin/env python3
"""
Generate synthetic IPOPHL submission files (PDF + DOCX) for all 13 upload zones
at 35%, 50%, 75%, and 100% rule-based readiness levels.

Output: data/ipophl_synthetic_submission/<task_id>/<pct>_percent/
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "machinelearning"))
sys.path.insert(0, str(ROOT))

OUTPUT_ROOT = ROOT / "data" / "ipophl_synthetic_submission"
READINESS_LEVELS = (35, 50, 75, 100)

from config.ipophl_store import IPOPHL_TASK_LABELS, OFFICIAL_IPOPHL_TASK_IDS  # noqa: E402
from machinelearning.ai_engine import GIAnalyzer  # noqa: E402

TASK_CHECKLISTS = GIAnalyzer().task_checklists


def terms_for_target(
    mandatory: list[str], optional: list[str], target: int
) -> tuple[list[str], list[str]]:
    """Pick mandatory/optional subsets whose rule-based score is closest to target."""
    n_m, n_o = len(mandatory), len(optional)
    best: tuple[int, list[str], list[str]] | None = None

    for dm in range(n_m + 1):
        for do in range(n_o + 1):
            m_score = (dm / max(1, n_m)) * 70
            o_score = (do / max(1, n_o)) * 30
            score = min(100, round(m_score + o_score))
            diff = abs(score - target)
            if best is None or diff < best[0] or (diff == best[0] and dm + do < len(best[1]) + len(best[2])):
                best = (diff, mandatory[:dm], optional[:do])
    assert best is not None
    return best[1], best[2]


def build_document_text(
    task_id: str,
    label: str,
    target_pct: int,
    included_mandatory: list[str],
    included_optional: list[str],
) -> str:
    # Keep the header free of checklist keywords so only selected blocks affect scoring.
    lines = [
        "SYNTHETIC IPOPHL SUBMISSION DOCUMENT",
        f"Upload zone: {task_id}",
        f"Completeness tier: {target_pct} percent",
        "",
    ]
    for term in included_mandatory + included_optional:
        # One line per term — avoids synonym bleed between checklist items.
        lines.append(term + ".")
    lines.append("")
    lines.append(
        "End of document. For Beanthentic IPOPHL module upload testing only."
    )
    return "\n".join(lines)


def write_docx(path: Path, text: str) -> None:
    from docx import Document

    doc = Document()
    for block in text.split("\n"):
        doc.add_paragraph(block if block.strip() else "")
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(path))


def write_pdf(path: Path, text: str) -> None:
    import fitz

    path.parent.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    margin = 50
    page_w, page_h = 595, 842
    width = page_w - 2 * margin
    rect_h = page_h - 2 * margin
    fontsize = 10
    line_height = fontsize * 1.35
    chars_per_line = max(40, int(width / (fontsize * 0.52)))
    wrapped: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph.strip():
            wrapped.append("")
            continue
        words = paragraph.split()
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if len(candidate) <= chars_per_line:
                line = candidate
            else:
                if line:
                    wrapped.append(line)
                line = word
        if line:
            wrapped.append(line)

    page = doc.new_page(width=page_w, height=page_h)
    y = margin
    for line in wrapped:
        if y + line_height > page_h - margin:
            page = doc.new_page(width=page_w, height=page_h)
            y = margin
        page.insert_text((margin, y), line, fontsize=fontsize, fontname="helv")
        y += line_height

    doc.save(str(path))
    doc.close()


def safe_filename(task_id: str, pct: int, ext: str) -> str:
    return f"{task_id}_{pct}pct{ext}"


def main() -> int:
    analyzer = GIAnalyzer()
    manifest: list[dict] = []
    errors: list[str] = []

    for task_id in OFFICIAL_IPOPHL_TASK_IDS:
        label = IPOPHL_TASK_LABELS.get(task_id, task_id)
        checklist = TASK_CHECKLISTS.get(task_id, {})
        mandatory = list(checklist.get("mandatory", []))
        optional = list(checklist.get("optional", []))

        for pct in READINESS_LEVELS:
            inc_m, inc_o = terms_for_target(mandatory, optional, pct)
            body = build_document_text(task_id, label, pct, inc_m, inc_o)
            folder = OUTPUT_ROOT / task_id / f"{pct}_percent"
            base = safe_filename(task_id, pct, "")
            pdf_path = folder / f"{base}.pdf"
            docx_path = folder / f"{base}.docx"

            write_docx(docx_path, body)
            write_pdf(pdf_path, body)

            checklist_cfg = {
                "mandatory_terms": mandatory,
                "optional_terms": optional,
            }
            for path in (pdf_path, docx_path):
                text = analyzer.extract_text_from_file(str(path))
                rule = analyzer._rule_based_analysis(text, checklist_cfg)
                merged = analyzer.analyze_document(str(path), task_id=task_id)
                rule_score = int(rule.get("readiness_score") or 0)
                merged_score = int(merged.get("readiness_score") or 0)
                manifest.append(
                    {
                        "task_id": task_id,
                        "label": label,
                        "target_percent": pct,
                        "file": str(path.relative_to(ROOT)).replace("\\", "/"),
                        "format": path.suffix.lower().lstrip("."),
                        "rule_based_score": rule_score,
                        "display_readiness_score": merged_score,
                        "status": merged.get("status"),
                        "mandatory_included": len(inc_m),
                        "mandatory_total": len(mandatory),
                        "optional_included": len(inc_o),
                        "optional_total": len(optional),
                    }
                )
                if abs(rule_score - pct) > 5:
                    errors.append(
                        f"{path.name}: target {pct}% vs rule-based {rule_score}% (task {task_id})"
                    )

    manifest_path = OUTPUT_ROOT / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "description": "Synthetic IPOPHL submission files for Beanthentic upload testing",
                "task_count": len(OFFICIAL_IPOPHL_TASK_IDS),
                "readiness_levels": list(READINESS_LEVELS),
                "formats": ["pdf", "docx"],
                "files": manifest,
            },
            f,
            indent=2,
            ensure_ascii=False,
        )

    total_files = len(OFFICIAL_IPOPHL_TASK_IDS) * len(READINESS_LEVELS) * 2
    print(f"Generated {total_files} files under {OUTPUT_ROOT}")
    print(f"Manifest: {manifest_path}")
    if errors:
        print(f"Warning: {len(errors)} file(s) scored >8 points from target:")
        for e in errors[:20]:
            print(f"  - {e}")
        if len(errors) > 20:
            print(f"  ... and {len(errors) - 20} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
