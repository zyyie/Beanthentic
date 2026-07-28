#!/usr/bin/env python3
"""
Build an expanded IPOPHL document training set and optionally train the RF model.

Usage (from project root):
    python scripts/build_document_training_data.py
    python scripts/build_document_training_data.py --train
    python scripts/build_document_training_data.py --train --reanalyze
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ML_DIR = ROOT / "machinelearning"
DATA_PATH = ML_DIR / "training_data" / "gi_documents_raw.json"
UPLOADS_DIR = ML_DIR / "uploads"
STORE_PATH = ROOT / "data" / "ipophl_documents.json"

sys.path.insert(0, str(ML_DIR))
sys.path.insert(0, str(ROOT))

from ai_engine import GIAnalyzer  # noqa: E402


GLOBAL_GI_CONTEXT = """
Geographical Indication (GI) registration — Lipa Barako Coffee.
Lipa City, Batangas, Philippines. Barako liberica coffee.
Quality Control and Production Process documentation for IPOPHL registrability.
"""


def _ready_body(task_id: str, mandatory: list[str], optional: list[str]) -> str:
    lines = [
        f"IPOPHL GI SUBMISSION — {task_id.replace('-', ' ').title()}",
        GLOBAL_GI_CONTEXT.strip(),
        "This document package supports Geographical Indication registration with IPOPHL.",
    ]
    for term in mandatory:
        lines.append(f"{term}: Fully documented, verified, and compliant with IPOPHL standards.")
    for term in optional:
        lines.append(f"{term}: Included as supporting evidence in this filing.")
    lines.append(
        "Publication and Opposition procedures acknowledged. "
        "Technical Validation and Government Certification references attached where applicable."
    )
    return "\n".join(lines)


def _not_ready_body(task_id: str, mandatory: list[str]) -> str:
    """Generic coffee text — missing most task mandatory terms."""
    return f"""
Draft notes for {task_id} (incomplete).

We grow coffee in the Philippines. The farm produces good beans each season.
Customers like the taste. We hope to apply for certification someday.
Some production and quality practices are described informally.
No complete application package is attached.
""".strip()


def _partial_body(task_id: str, mandatory: list[str]) -> str:
    """Only first mandatory term present — borderline Not Ready."""
    first = mandatory[0] if mandatory else "documentation"
    return f"""
Partial {task_id} draft.

{first}: mentioned briefly but not fully substantiated.
General coffee farming information for Lipa area.
Missing formal IPOPHL structure and remaining mandatory sections.
""".strip()


def _half_mandatory_body(task_id: str, mandatory: list[str]) -> str:
    half = mandatory[: max(1, len(mandatory) // 2)]
    lines = [f"Incomplete IPOPHL draft — {task_id}", GLOBAL_GI_CONTEXT.strip()]
    for term in half:
        lines.append(f"{term}: partially addressed.")
    lines.append("Remaining mandatory sections are not yet attached.")
    return "\n".join(lines)


def _ready_narrative(task_id: str, mandatory: list[str], optional: list[str]) -> str:
    terms = ", ".join(mandatory[:3])
    opt = ", ".join(optional[:2]) if optional else ""
    return f"""
Republic of the Philippines — IPOPHL GI Registration Narrative
Document category: {task_id.replace("-", " ").title()}

The Lipa Barako Producers Association submits this filing for Kapeng Barako
(Coffea liberica) Geographical Indication in Lipa City, Batangas. This narrative
documents {terms} in accordance with Intellectual Property Code compliance.

Supporting elements include {opt}. Production Process and Quality Control follow
traditional cultivation and post-harvest practices verified by LGU partners.
Geographical Indication registrability is demonstrated through distinctive
Barako flavor profile and Batangas origin linkage.
""".strip()


def _ready_formal_letter(task_id: str, mandatory: list[str], optional: list[str]) -> str:
    lines = [
        "DEPARTMENT OF TRADE AND INDUSTRY / IPOPHL — TRANSMITTAL",
        f"Re: {task_id.replace('-', ' ').title()} — Lipa Barako Coffee GI",
        "To the Bureau of Trademarks:",
        "",
        "Please find enclosed our Geographical Indication application materials.",
    ]
    for term in mandatory:
        lines.append(f"  • {term} — certified copy attached.")
    for term in optional:
        lines.append(f"  • {term} — supplementary annex.")
    lines += [
        "",
        "Lipa City, Batangas. Barako Coffee. Official Receipt and Application Fee",
        "documentation filed separately. Publication for Opposition acknowledged.",
        "Respectfully submitted, Lipa Barako Coffee Growers Cooperative.",
    ]
    return "\n".join(lines)


def _ready_checklist(task_id: str, mandatory: list[str], optional: list[str]) -> str:
    lines = [f"IPOPHL COMPLIANCE CHECKLIST — {task_id.upper()}", "GI: Lipa Barako | Lipa City | Batangas"]
    for i, term in enumerate(mandatory, 1):
        lines.append(f"[X] {i}. {term} — COMPLIANT")
    for i, term in enumerate(optional, 1):
        lines.append(f"[X] Optional {i}. {term} — PROVIDED")
    return "\n".join(lines)


def _ready_ocr_style(task_id: str, mandatory: list[str], optional: list[str]) -> str:
    """Simulates OCR output with minor spacing artifacts."""
    base = _ready_body(task_id, mandatory, optional)
    return base.replace("Geographical", "Geograph ical").replace("Specifications", "Specificat ions")


def _wrong_category_body(task_id: str) -> str:
    return f"""
Menu — Sari-Sari Cafe Lipa

Espresso PHP 120 | Latte PHP 150 | Barako drip PHP 100
Open daily 7am-9pm. WiFi available. No GI filing content.
Tagged as {task_id} by mistake during upload testing.
""".strip()


def _arabica_robusta_body() -> str:
    return """
Coffee Export Brochure — Arabica and Robusta blend from Mindanao.
Premium beans for international markets. No Lipa City GI claim.
Sustainable farming. Quality control at export facility. Not a Barako GI filing.
""".strip()


def _append_row(
    rows: list[dict],
    *,
    text: str,
    label: str,
    score: int,
    source: str,
    task_id: str | None = None,
    notes: str = "",
) -> None:
    rows.append({
        "text": text,
        "label": label,
        "score": score,
        "source": source,
        **({"task_id": task_id} if task_id else {}),
        "notes": notes,
    })


def generate_extended_samples(analyzer: GIAnalyzer) -> list[dict]:
    """Additional variants to reach ~200 total training documents."""
    rows: list[dict] = []
    for task_id, checklist in analyzer.task_checklists.items():
        mandatory = checklist["mandatory"]
        optional = checklist["optional"]

        variants = [
            (_ready_narrative(task_id, mandatory, optional), "Ready", 92, "generated_narrative", f"Narrative Ready — {task_id}"),
            (_ready_formal_letter(task_id, mandatory, optional), "Ready", 94, "generated_letter", f"Formal letter Ready — {task_id}"),
            (_ready_checklist(task_id, mandatory, optional), "Ready", 98, "generated_checklist", f"Checklist Ready — {task_id}"),
            (_ready_ocr_style(task_id, mandatory, optional), "Ready", 90, "generated_ocr", f"OCR-style Ready — {task_id}"),
            (_half_mandatory_body(task_id, mandatory), "Not Ready", 42, "generated_half", f"Half mandatory — {task_id}"),
            (_wrong_category_body(task_id), "Not Ready", 8, "generated_wrong_type", f"Wrong category — {task_id}"),
        ]
        for text, label, score, source, notes in variants:
            if label == "Ready":
                rule = analyzer._rule_based_analysis(
                    text,
                    {"mandatory_terms": mandatory, "optional_terms": optional},
                )
                score = int(rule.get("readiness_score") or score)
            _append_row(rows, text=text, label=label, score=score, source=source, task_id=task_id, notes=notes)

    for i in range(5):
        _append_row(
            rows,
            text=_arabica_robusta_body() + f"\nVariant {i + 1}.",
            label="Not Ready",
            score=15,
            source="hard_negative",
            notes=f"Non-Barako coffee brochure variant {i + 1}",
        )

    extra_negatives = [
        ("Employee timesheet — hours worked March 2026. No GI content.", "Not Ready", 3, "Timesheet"),
        ("Bank statement summary. Account ending 4521. Deposits and withdrawals.", "Not Ready", 2, "Bank statement"),
        ("University thesis abstract about social media marketing trends.", "Not Ready", 1, "Unrelated academic"),
        ("Restaurant health permit renewal — City of Lipa sanitation office.", "Not Ready", 5, "Health permit"),
        ("Lease agreement for warehouse space — monthly rent PHP 25,000.", "Not Ready", 4, "Lease contract"),
        ("Travel itinerary — Manila to Cebu flight booking confirmation.", "Not Ready", 2, "Travel booking"),
        ("Medical prescription — patient name redacted. Not agricultural.", "Not Ready", 1, "Medical document"),
        ("Job application resume — barista position at mall coffee shop.", "Not Ready", 6, "Resume"),
    ]
    for text, label, score, note in extra_negatives:
        _append_row(rows, text=text, label=label, score=score, source="hard_negative", notes=note)

    return rows


def generate_task_samples(analyzer: GIAnalyzer) -> list[dict]:
    rows: list[dict] = []
    for task_id, checklist in analyzer.task_checklists.items():
        mandatory = checklist["mandatory"]
        optional = checklist["optional"]

        ready_text = _ready_body(task_id, mandatory, optional)
        rule = analyzer._rule_based_analysis(
            ready_text,
            {"mandatory_terms": mandatory, "optional_terms": optional},
        )
        rows.append({
            "text": ready_text,
            "label": "Ready",
            "score": rule["readiness_score"],
            "source": "generated",
            "task_id": task_id,
            "notes": f"Auto-generated Ready sample for {task_id}",
        })

        # Second Ready variant (paraphrased) for class balance
        variant_lines = [
            f"Complete IPOPHL filing — {task_id}",
            "Lipa City Batangas Barako Coffee Geographical Indication (GI).",
            "MoP Manual of Specifications, Production Process, Quality Control, Labeling Rules.",
            "Applicant Entity and Producers Organization documentation on file.",
        ]
        for term in mandatory:
            variant_lines.append(f"Section: {term} — satisfies IPOPHL formality examination.")
        for term in optional:
            variant_lines.append(f"Annex: {term}.")
        variant_text = "\n".join(variant_lines)
        rows.append({
            "text": variant_text,
            "label": "Ready",
            "score": 95,
            "source": "generated_variant",
            "task_id": task_id,
            "notes": f"Paraphrased Ready sample for {task_id}",
        })

        not_ready_text = _not_ready_body(task_id, mandatory)
        rows.append({
            "text": not_ready_text,
            "label": "Not Ready",
            "score": 20,
            "source": "generated",
            "task_id": task_id,
            "notes": f"Auto-generated Not Ready sample for {task_id}",
        })

        partial_text = _partial_body(task_id, mandatory)
        rows.append({
            "text": partial_text,
            "label": "Not Ready",
            "score": 35,
            "source": "generated",
            "task_id": task_id,
            "notes": f"Auto-generated partial draft for {task_id}",
        })
    return rows


HARD_NEGATIVES = [
    {
        "text": """
        AUTHORIZATION LETTER
        Date: February 27, 2026
        I hereby authorize my representative to claim documents on my behalf.
        Signed for administrative purposes only.
        """.strip(),
        "label": "Not Ready",
        "score": 10,
        "source": "hard_negative",
        "notes": "Non-GI authorization letter",
    },
    {
        "text": """
        INVOICE #4421
        Item: Office supplies. Total: PHP 1,250.00. Paid in cash.
        """.strip(),
        "label": "Not Ready",
        "score": 5,
        "source": "hard_negative",
        "notes": "Unrelated commercial invoice",
    },
    {
        "text": """
        SYNTHETIC IPOPHL SUBMISSION DOCUMENT
        Upload zone: phase1-product
        Completeness tier: 100 percent
        Lipa Barako coffee. Flavor Profile. Geographical Origin. Distinctive Quality.
        Product Photos. Aroma. Roasting Process. Farming Practices.
        End of document.
        """.strip(),
        "label": "Ready",
        "score": 100,
        "source": "synthetic_upload",
        "task_id": "phase1-product",
        "notes": "100% phase1-product keyword test document",
    },
]


def ingest_local_uploads(analyzer: GIAnalyzer) -> list[dict]:
    rows: list[dict] = []
    skip_suffixes = {".csv", ".joblib", ".npy"}
    for path in sorted(UPLOADS_DIR.iterdir()):
        if not path.is_file() or path.suffix.lower() in skip_suffixes:
            continue
        try:
            text = analyzer.extract_text_from_file(str(path)).strip()
        except Exception:
            continue
        if len(text) < 10:
            continue
        task_id = analyzer._resolve_task_id_from_text(text, None) or "ipophl-other"
        checklist = analyzer.gi_checklist
        if task_id in analyzer.task_checklists:
            cl = analyzer.task_checklists[task_id]
            checklist = {"mandatory_terms": cl["mandatory"], "optional_terms": cl["optional"]}
        rule = analyzer._rule_based_analysis(text, checklist)
        score = int(rule.get("readiness_score") or 0)
        label = "Ready" if not rule.get("missing_requirements") and score >= 75 else "Not Ready"
        rows.append({
            "text": text,
            "label": label,
            "score": score,
            "source": "upload",
            "task_id": task_id,
            "notes": f"Ingested from uploads/{path.name}",
        })
    return rows


def load_legacy_samples() -> list[dict]:
    if not DATA_PATH.exists():
        return []
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return [d for d in data if d.get("source") == "sample"]


def dedupe_by_text(rows: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for row in rows:
        key = " ".join(row["text"].split())[:500]
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    return out


def _pad_to_target(rows: list[dict], analyzer: GIAnalyzer, target: int) -> list[dict]:
    """Add minimal unique filler rows until target count is reached."""
    if len(rows) >= target:
        return rows
    task_ids = list(analyzer.task_checklists.keys())
    idx = 0
    while len(rows) < target:
        task_id = task_ids[idx % len(task_ids)]
        checklist = analyzer.task_checklists[task_id]
        mandatory = checklist["mandatory"]
        optional = checklist["optional"]
        variant_num = idx // len(task_ids) + 1
        if idx % 3 == 0:
            text = _ready_body(task_id, mandatory, optional) + f"\nSupplemental filing batch {variant_num}."
            label, source, score = "Ready", "generated_pad_ready", 88
        else:
            text = _not_ready_body(task_id, mandatory) + f"\nDraft revision {variant_num} — still incomplete."
            label, source, score = "Not Ready", "generated_pad_not_ready", 18
        rows.append({
            "text": text,
            "label": label,
            "score": score,
            "source": source,
            "task_id": task_id,
            "notes": f"Padded sample {variant_num} for {task_id}",
        })
        idx += 1
    return rows


def build_dataset(target: int = 200) -> list[dict]:
    """Build training data — official MoP files (n1–n7) are the default baseline."""
    try:
        from machinelearning.official_mop_dataset import (
            DEFAULT_JSON_PATH,
            build_official_mop_dataset,
        )

        official = build_official_mop_dataset(ROOT, augment=True)
        with open(DEFAULT_JSON_PATH, encoding="utf-8") as f:
            rows = json.load(f)
        print(
            f"Official MoP baseline: {official['csv_rows']} CSV rows, "
            f"{official['training_rows']} training rows"
        )
        if rows:
            DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
            with open(DATA_PATH, "w", encoding="utf-8") as f:
                json.dump(rows, f, indent=2, ensure_ascii=False)
            ready = sum(1 for r in rows if r.get("label") == "Ready")
            print(f"Wrote {len(rows)} documents to {DATA_PATH} (Ready: {ready}, Not Ready: {len(rows) - ready})")
            return rows
    except Exception as exc:
        print(f"Official MoP build failed, falling back to extended generator: {exc}")

    analyzer = GIAnalyzer(str(UPLOADS_DIR))
    rows: list[dict] = []
    rows.extend(load_legacy_samples())
    rows.extend(generate_task_samples(analyzer))
    rows.extend(generate_extended_samples(analyzer))
    rows.extend(HARD_NEGATIVES)
    rows.extend(ingest_local_uploads(analyzer))
    rows = dedupe_by_text(rows)
    rows = _pad_to_target(rows, analyzer, target)
    rows = dedupe_by_text(rows)
    if len(rows) < target:
        rows = _pad_to_target(rows, analyzer, target)
    rows = rows[:target] if len(rows) > target else rows
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False)
    ready = sum(1 for r in rows if r["label"] == "Ready")
    not_ready = len(rows) - ready
    print(f"Wrote {len(rows)} documents to {DATA_PATH} (Ready: {ready}, Not Ready: {not_ready})")
    return rows


def train_model() -> dict:
    import subprocess

    proc = subprocess.run(
        [
            sys.executable,
            str(ML_DIR / "train_ai_model.py"),
            "--train-documents",
            "--data-dir",
            str(ML_DIR / "training_data"),
        ],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    print(proc.stdout)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr)
    if proc.returncode != 0:
        raise RuntimeError("Document model training failed")
    results_path = ML_DIR / "document_training_results.json"
    return json.loads(results_path.read_text(encoding="utf-8"))


def reanalyze_store(analyzer: GIAnalyzer) -> int:
    if not STORE_PATH.exists():
        return 0
    store = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    updated = 0
    for file_uuid, record in store.items():
        from config.ipophl_store import resolve_file_path

        path = resolve_file_path(file_uuid, filename_hint=record.get("original_filename"))
        if not path or not path.exists():
            fp = record.get("file_path", "")
            path = Path(fp) if fp and Path(fp).exists() else None
        if not path or not path.exists():
            continue
        task = record.get("task_id") or "ipophl-other"
        result = analyzer.analyze_document(str(path), task_id=task)
        if not result.get("success", True):
            continue
        record["ai_score"] = int(result.get("readiness_score") or 0)
        record["ai_status"] = result.get("status") or record.get("ai_status")
        record["detected_features"] = result.get("detected_features") or []
        record["missing_requirements"] = result.get("missing_requirements") or []
        record["analysis_method"] = result.get("analysis_method") or record.get("analysis_method")
        record["text_length"] = result.get("text_length") or 0
        record["shap_analysis"] = result.get("shap_analysis") or ""
        record["analysis_timestamp"] = datetime.now(timezone.utc).isoformat()
        if result.get("task_id"):
            record["task_id"] = result["task_id"]
            if str(result["task_id"]).startswith("phase"):
                record["ipophl_phase"] = str(result["task_id"]).split("-", 1)[0]
        updated += 1
        print(f"  Re-analyzed {record.get('original_filename', file_uuid)} -> {record['ai_score']}%")
    STORE_PATH.write_text(json.dumps(store, indent=2), encoding="utf-8")
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(description="Build IPOPHL document training data")
    parser.add_argument("--train", action="store_true", help="Train gi_document_model.joblib after build")
    parser.add_argument("--reanalyze", action="store_true", help="Re-score documents in ipophl_documents.json")
    parser.add_argument("--target", type=int, default=200, help="Target number of training documents (default: 200)")
    args = parser.parse_args()

    if args.reanalyze and not args.train:
        analyzer = GIAnalyzer(str(UPLOADS_DIR), auto_train=False)
        count = reanalyze_store(analyzer)
        print(f"Re-analyzed {count} stored document(s)")
        return

    build_dataset(target=max(10, args.target))

    if args.train:
        results = train_model()
        print(
            f"Training done — accuracy={results.get('accuracy')}, "
            f"cv_mean={results.get('cv_mean')}"
        )

    if args.reanalyze:
        analyzer = GIAnalyzer(str(UPLOADS_DIR), auto_train=False)
        count = reanalyze_store(analyzer)
        print(f"Re-analyzed {count} stored document(s)")


if __name__ == "__main__":
    main()
