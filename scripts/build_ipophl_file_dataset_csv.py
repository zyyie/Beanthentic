#!/usr/bin/env python3
"""
Build a CSV training dataset from real IPOPHL document files.

Each file becomes one or more rows (n1, n2, n3, ...) with extracted text
and MoP-based Ready / Not Ready labels.

Usage (from project root):
    python scripts/build_ipophl_file_dataset_csv.py
    python scripts/build_ipophl_file_dataset_csv.py --split paragraph
    python scripts/build_ipophl_file_dataset_csv.py --source machinelearning/uploads
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Iterator

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
ML_DIR = ROOT / "machinelearning"
STORE_PATH = ROOT / "data" / "ipophl_documents.json"
DEFAULT_OUT = ML_DIR / "training_data" / "ipophl_files_dataset.csv"

sys.path.insert(0, str(ML_DIR))
sys.path.insert(0, str(ROOT))

from ai_engine import GIAnalyzer  # noqa: E402
from gi_reference_basis import evaluate_against_reference  # noqa: E402

SUPPORTED_SUFFIXES = {".pdf", ".doc", ".docx", ".txt", ".md"}
SKIP_SUFFIXES = {".csv", ".joblib", ".npy", ".pkl"}

# Filename → official task_id (Lipa City Kapeng Barako MoP zones)
FILENAME_TASK_HINTS: list[tuple[str, str]] = [
    (r"introduction.*reputation|reputation.*introduction", "phase1-introduction"),
    (r"history.*barako|kapeng\s*barako", "phase1-history"),
    (r"physical.*link|link.*territory", "phase1-physical-link"),
    (r"general\s*description|technical.*general", "phase2-general"),
    (r"specific\s*description|technical.*specific", "phase2-specific"),
    (r"production\s*process|technical.*production", "phase2-production"),
    (r"control|traceability", "phase3-control"),
]


def _guess_task_id(path: Path, text: str, analyzer: GIAnalyzer) -> str:
    name = path.name.lower()
    for pattern, task_id in FILENAME_TASK_HINTS:
        if re.search(pattern, name, re.I):
            return task_id
    resolved = analyzer._resolve_task_id_from_text(text, None)
    return resolved or "ipophl-other"


def _split_text(text: str, mode: str, chunk_words: int) -> list[str]:
    text = text.strip()
    if not text:
        return []

    if mode == "whole":
        return [text]

    if mode == "paragraph":
        parts = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
        return parts if parts else [text]

    # word chunks
    words = text.split()
    if len(words) <= chunk_words:
        return [text]
    chunks: list[str] = []
    for i in range(0, len(words), chunk_words):
        chunk = " ".join(words[i : i + chunk_words]).strip()
        if chunk:
            chunks.append(chunk)
    return chunks


def _iter_files(sources: list[Path]) -> Iterator[Path]:
    seen: set[str] = set()
    for source in sources:
        if not source.exists():
            continue
        if source.is_file():
            candidates = [source]
        else:
            candidates = sorted(source.rglob("*"))
        for path in candidates:
            if not path.is_file():
                continue
            suffix = path.suffix.lower()
            if suffix in SKIP_SUFFIXES or suffix not in SUPPORTED_SUFFIXES:
                continue
            key = str(path.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            yield path


def _load_store_index() -> dict[str, dict]:
    if not STORE_PATH.exists():
        return {}
    try:
        data = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    by_path: dict[str, dict] = {}
    for record in data.values():
        fp = str(record.get("file_path") or "").replace("\\", "/").lower()
        if fp:
            by_path[fp] = record
        orig = str(record.get("original_filename") or "").lower()
        if orig:
            by_path[orig] = record
    return by_path


def build_rows(
    analyzer: GIAnalyzer,
    sources: list[Path],
    *,
    split_mode: str = "whole",
    chunk_words: int = 400,
    id_prefix: str = "n",
) -> list[dict]:
    store_index = _load_store_index()
    rows: list[dict] = []
    sample_counter = 0

    for file_idx, path in enumerate(_iter_files(sources), start=1):
        file_id = f"f{file_idx}"
        rel = str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)
        store_hit = store_index.get(rel.replace("\\", "/").lower()) or store_index.get(
            path.name.lower()
        )

        try:
            text = analyzer.extract_text_from_file(str(path)).strip()
        except Exception as exc:
            print(f"  skip (extract error): {path.name} — {exc}")
            continue

        if len(text) < 20:
            print(f"  skip (too short): {path.name}")
            continue

        task_id = (
            str(store_hit.get("task_id") or "").strip()
            if store_hit
            else _guess_task_id(path, text, analyzer)
        )
        if not task_id:
            task_id = "ipophl-other"

        eval_result = evaluate_against_reference(text, task_id=task_id)
        ai_status = str(eval_result.get("status") or "Not Ready")
        label = 1 if ai_status.lower() == "ready" else 0

        # Prefer stored dashboard status when available (expert override path)
        if store_hit and store_hit.get("ai_status"):
            ai_status = str(store_hit["ai_status"])
            label = 1 if ai_status.lower() == "ready" else 0

        parts = _split_text(text, split_mode, chunk_words)
        for split_idx, part in enumerate(parts, start=1):
            sample_counter += 1
            sample_id = f"{id_prefix}{sample_counter}"
            if split_mode != "whole" and len(parts) > 1:
                sample_id = f"{id_prefix}{sample_counter}"  # global n1, n2, n3...

            rows.append(
                {
                    "sample_id": sample_id,
                    "file_id": file_id,
                    "split_index": split_idx,
                    "split_total": len(parts),
                    "source_file": path.name,
                    "source_path": rel,
                    "task_id": task_id,
                    "word_count": len(part.split()),
                    "char_count": len(part),
                    "text": part,
                    "text_preview": part[:240].replace("\n", " "),
                    "ai_status": ai_status,
                    "lipa_gi_compliant": label,
                    "label": "Ready" if label == 1 else "Not Ready",
                }
            )

        print(f"  {file_id} -> {len(parts)} row(s): {path.name} [{task_id}] = {ai_status}")

    return rows


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export real IPOPHL files to a numbered CSV dataset (n1, n2, ...)."
    )
    parser.add_argument(
        "--source",
        action="append",
        default=[],
        help="File or folder to ingest (repeatable). Defaults to uploads + PART folders.",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUT),
        help="Output CSV path.",
    )
    parser.add_argument(
        "--split",
        choices=["whole", "paragraph", "chunk"],
        default="whole",
        help="whole=1 row per file; paragraph=split on blank lines; chunk=N-word windows.",
    )
    parser.add_argument(
        "--chunk-words",
        type=int,
        default=400,
        help="Words per chunk when --split chunk.",
    )
    parser.add_argument(
        "--prefix",
        default="n",
        help="Sample ID prefix (n1, n2, ...).",
    )
    args = parser.parse_args()

    if args.source:
        sources = [ROOT / s if not Path(s).is_absolute() else Path(s) for s in args.source]
    else:
        sources = [
            ML_DIR / "uploads",
            ROOT / "uploads" / "gi_contributions",
        ]
        # Official MoP drafting folders
        for part_dir in ROOT.glob("PART *"):
            if part_dir.is_dir():
                sources.append(part_dir)

    analyzer = GIAnalyzer(str(ML_DIR / "uploads"))
    print("Building file-based dataset...")
    rows = build_rows(
        analyzer,
        sources,
        split_mode=args.split,
        chunk_words=args.chunk_words,
        id_prefix=args.prefix,
    )

    if not rows:
        print("No rows generated. Check --source paths and file types.")
        sys.exit(1)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(rows)
    df.to_csv(out, index=False, encoding="utf-8")

    ready = int(df["lipa_gi_compliant"].sum())
    print(f"\nWrote {len(df)} rows from {df['file_id'].nunique()} files -> {out}")
    print(f"  Ready:     {ready}")
    print(f"  Not Ready: {len(df) - ready}")
    print(f"  Split mode: {args.split}")


if __name__ == "__main__":
    main()
