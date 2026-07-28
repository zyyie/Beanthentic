"""
Official Kapeng Barako MoP document sources (Part 1, Part 2, Control & Traceability).

Used as the default training and RF validation baseline for IPOPHL analysis.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
ML_DIR = Path(__file__).resolve().parent

OFFICIAL_MOP_SPECS: list[dict[str, str]] = [
    {
        "sample_id": "n1",
        "task_id": "phase1-introduction",
        "part": "Part 1 — Justification",
        "label": "Introduction & Reputation",
        "relative_path": (
            "PART 1 - Justification for the Request for Protection-20260724T153341Z-1-001"
            "/PART 1 - Justification for the Request for Protection"
            "/Introduction & Reputation.docx"
        ),
    },
    {
        "sample_id": "n2",
        "task_id": "phase1-history",
        "part": "Part 1 — Justification",
        "label": "History of Kapeng Barako",
        "relative_path": (
            "PART 1 - Justification for the Request for Protection-20260724T153341Z-1-001"
            "/PART 1 - Justification for the Request for Protection"
            "/History of Kapeng Barako.docx"
        ),
    },
    {
        "sample_id": "n3",
        "task_id": "phase1-physical-link",
        "part": "Part 1 — Justification",
        "label": "Physical Link to the Territory",
        "relative_path": (
            "PART 1 - Justification for the Request for Protection-20260724T153341Z-1-001"
            "/PART 1 - Justification for the Request for Protection"
            "/Physical link to the territory.docx"
        ),
    },
    {
        "sample_id": "n4",
        "task_id": "phase2-general",
        "part": "Part 2 — Technical",
        "label": "TECHNICAL — General Description",
        "relative_path": (
            "PART 2 - Technical Part-20260724T153344Z-1-001"
            "/PART 2 - Technical Part"
            "/TECHNICAL - General Description.docx"
        ),
    },
    {
        "sample_id": "n5",
        "task_id": "phase2-specific",
        "part": "Part 2 — Technical",
        "label": "TECHNICAL — Specific Description",
        "relative_path": (
            "PART 2 - Technical Part-20260724T153344Z-1-001"
            "/PART 2 - Technical Part"
            "/TECHNICAL - Specific Description of the Production.docx"
        ),
    },
    {
        "sample_id": "n6",
        "task_id": "phase2-production",
        "part": "Part 2 — Technical",
        "label": "TECHNICAL — The Production Process",
        "relative_path": (
            "PART 2 - Technical Part-20260724T153344Z-1-001"
            "/PART 2 - Technical Part"
            "/TECHNICAL - The Production Process.docx"
        ),
    },
    {
        "sample_id": "n7",
        "task_id": "phase3-control",
        "part": "Control & Traceability",
        "label": "Control & Traceability & Labelling",
        "relative_path": "CONTROL & TRACEABILITY & LABELLING.docx",
    },
]

DEFAULT_CSV_PATH = ML_DIR / "training_data" / "ipophl_official_mop_dataset.csv"
DEFAULT_JSON_PATH = ML_DIR / "training_data" / "gi_documents_raw.json"
MANIFEST_PATH = ML_DIR / "training_data" / "official_mop_manifest.json"


def resolve_official_paths(root: Path | None = None) -> list[dict[str, Any]]:
    """Return official MoP specs with resolved absolute paths (skip missing)."""
    base = root or ROOT
    resolved: list[dict[str, Any]] = []
    for spec in OFFICIAL_MOP_SPECS:
        path = base / spec["relative_path"]
        item = dict(spec)
        item["source_path"] = str(path)
        item["source_file"] = path.name
        item["exists"] = path.is_file()
        resolved.append(item)
    return resolved


def _not_ready_stub(task_id: str, label: str) -> str:
    return f"""
Incomplete draft for {label} ({task_id}).

General coffee farming notes for the Philippines. Some production practices are mentioned
informally. This upload does not yet substantiate Kapeng Barako / Coffea liberica from
Lipa City, Batangas with the MoP themes required for IPOPHL GI registration.
""".strip()


def _partial_stub(task_id: str, label: str, snippet: str) -> str:
    words = snippet.split()
    excerpt = " ".join(words[: min(120, len(words))])
    return (
        f"Partial {label} excerpt ({task_id}).\n\n{excerpt}\n\n"
        "Remaining mandatory MoP sections are not yet attached."
    )


def augment_for_rf_training(base_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Expand 7 official rows with balanced Not Ready examples for Random Forest."""
    out = list(base_rows)
    for row in base_rows:
        task_id = row["task_id"]
        label = row.get("task_label") or task_id
        text = row.get("text") or ""
        out.append(
            {
                "text": _not_ready_stub(task_id, label),
                "label": "Not Ready",
                "score": 15,
                "source": "official_mop_negative_stub",
                "task_id": task_id,
                "notes": f"Incomplete stub for {task_id}",
            }
        )
        if len(text.split()) > 80:
            out.append(
                {
                    "text": _partial_stub(task_id, label, text),
                    "label": "Not Ready",
                    "score": 35,
                    "source": "official_mop_partial",
                    "task_id": task_id,
                    "notes": f"Truncated excerpt for {task_id}",
                }
            )
    return out


def build_official_mop_dataset(
    root: Path | None = None,
    *,
    csv_path: Path | None = None,
    json_path: Path | None = None,
    augment: bool = True,
) -> dict[str, Any]:
    """
    Build CSV + JSON from Part 1, Part 2, and Control & Traceability MoP files.

    Labels come from qualitative MoP evaluation (gi_reference_basis).
    """
    import sys

    sys.path.insert(0, str(ML_DIR))
    sys.path.insert(0, str(ROOT))

    from ai_engine import GIAnalyzer  # noqa: WPS433
    from gi_reference_basis import evaluate_against_reference  # noqa: WPS433

    base = root or ROOT
    out_csv = csv_path or DEFAULT_CSV_PATH
    out_json = json_path or DEFAULT_JSON_PATH
    analyzer = GIAnalyzer(str(ML_DIR / "uploads"), auto_train=False)

    csv_rows: list[dict[str, Any]] = []
    json_rows: list[dict[str, Any]] = []
    manifest_files: list[dict[str, Any]] = []

    for spec in resolve_official_paths(base):
        if not spec["exists"]:
            continue
        path = Path(spec["source_path"])
        text = analyzer.extract_text_from_file(str(path)).strip()
        if len(text) < 20:
            continue

        task_id = spec["task_id"]
        review = evaluate_against_reference(text, task_id=task_id)
        status = str(review.get("status") or "Not Ready")
        label = "Ready" if status.lower() == "ready" else "Not Ready"
        score = 100 if label == "Ready" else 20

        rel = str(path.relative_to(base)) if path.is_relative_to(base) else str(path)
        csv_rows.append(
            {
                "sample_id": spec["sample_id"],
                "task_id": task_id,
                "task_label": spec["label"],
                "mop_part": spec["part"],
                "source_file": spec["source_file"],
                "source_path": rel,
                "word_count": len(text.split()),
                "char_count": len(text),
                "text": text,
                "text_preview": text[:300].replace("\n", " "),
                "ai_status": status,
                "label": label,
                "lipa_gi_compliant": 1 if label == "Ready" else 0,
                "reference_source": review.get("reference_source"),
            }
        )
        json_rows.append(
            {
                "text": text,
                "label": label,
                "score": score,
                "source": "official_mop",
                "task_id": task_id,
                "notes": f"Official MoP: {spec['label']}",
            }
        )
        manifest_files.append(
            {
                "sample_id": spec["sample_id"],
                "task_id": task_id,
                "path": rel,
                "status": status,
                "word_count": len(text.split()),
            }
        )

    if augment and json_rows:
        json_rows = augment_for_rf_training(
            [
                {
                    "text": r["text"],
                    "label": r["label"],
                    "score": r["score"],
                    "task_id": r["task_id"],
                    "task_label": next(
                        (s["label"] for s in OFFICIAL_MOP_SPECS if s["task_id"] == r["task_id"]),
                        r["task_id"],
                    ),
                }
                for r in json_rows
            ]
        )

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(csv_rows).to_csv(out_csv, index=False, encoding="utf-8")
    json_payload = json.dumps(json_rows, indent=2, ensure_ascii=False)
    tmp_json = out_json.with_suffix(".json.tmp")
    tmp_json.write_text(json_payload, encoding="utf-8")
    tmp_json.replace(out_json)

    manifest = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "official_file_count": len(csv_rows),
        "training_row_count": len(json_rows),
        "csv_path": str(out_csv.relative_to(base)) if out_csv.is_relative_to(base) else str(out_csv),
        "json_path": str(out_json.relative_to(base)) if out_json.is_relative_to(base) else str(out_json),
        "files": manifest_files,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return {
        "csv_path": out_csv,
        "json_path": out_json,
        "manifest_path": MANIFEST_PATH,
        "csv_rows": len(csv_rows),
        "training_rows": len(json_rows),
        "ready": sum(1 for r in csv_rows if r["label"] == "Ready"),
        "not_ready": sum(1 for r in csv_rows if r["label"] != "Ready"),
    }


def sync_official_mop_pipeline(
    root: Path | None = None,
    *,
    train: bool = False,
) -> dict[str, Any]:
    """Build official CSV/JSON and optionally retrain gi_document_model.joblib."""
    result = build_official_mop_dataset(root)
    if not train:
        return result

    import subprocess
    import sys

    proc = subprocess.run(
        [
            sys.executable,
            str(ML_DIR / "train_ai_model.py"),
            "--train-documents",
            "--data-dir",
            "machinelearning/training_data",
        ],
        cwd=str(root or ROOT),
        capture_output=True,
        text=True,
        timeout=300,
    )
    result["train_ok"] = proc.returncode == 0
    result["train_log"] = (proc.stdout or "")[-1500:]
    if proc.returncode != 0:
        result["train_error"] = (proc.stderr or proc.stdout or "")[-1500:]
    return result
