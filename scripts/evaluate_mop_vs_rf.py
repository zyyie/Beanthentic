#!/usr/bin/env python3
"""
Compare MoP qualitative AI vs Random Forest on IPOPHL documents.

Use this to report "validation accuracy" for your capstone:
  - MoP rules = primary judge (ground truth for the system)
  - Random Forest = statistical validator (should agree most of the time)

Usage:
    python scripts/evaluate_mop_vs_rf.py
    python scripts/evaluate_mop_vs_rf.py --csv machinelearning/training_data/ipophl_files_dataset.csv
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ML_DIR = ROOT / "machinelearning"
sys.path.insert(0, str(ML_DIR))
sys.path.insert(0, str(ROOT))

from ai_engine import GIAnalyzer  # noqa: E402


def _mop_status(analyzer: GIAnalyzer, text: str, task_id: str) -> str:
    result = analyzer._rule_based_analysis(text, task_id=task_id)
    return str(result.get("status") or "Not Ready")


def _rf_ready(analyzer: GIAnalyzer, text: str, threshold: int = 75) -> tuple[bool, int | None]:
    features = analyzer._extract_features(text)
    score = analyzer._random_forest_document_score(features)
    if score is None:
        return False, None
    return int(score) >= threshold, int(score)


def evaluate_from_store(analyzer: GIAnalyzer, threshold: int = 75) -> dict:
    store_path = ROOT / "data" / "ipophl_documents.json"
    if not store_path.exists():
        return {"rows": [], "summary": {}}

    from config.ipophl_store import resolve_file_path

    store = json.loads(store_path.read_text(encoding="utf-8"))
    rows = []
    for record in store.values():
        path = resolve_file_path(
            record.get("file_uuid", ""),
            filename_hint=record.get("original_filename"),
        )
        if not path or not path.exists():
            fp = record.get("file_path")
            path = Path(fp) if fp and Path(fp).exists() else None
        if not path:
            continue
        task_id = str(record.get("task_id") or "ipophl-other")
        try:
            text = analyzer.extract_text_from_file(str(path)).strip()
        except Exception:
            continue
        if len(text) < 20:
            continue

        mop = _mop_status(analyzer, text, task_id)
        rf_ok, rf_score = _rf_ready(analyzer, text, threshold)
        mop_ok = mop.lower() == "ready"
        rows.append(
            {
                "file": record.get("original_filename") or path.name,
                "task_id": task_id,
                "mop_status": mop,
                "rf_score": rf_score,
                "rf_status": "Ready" if rf_ok else "Not Ready",
                "agrees": mop_ok == rf_ok if rf_score is not None else None,
            }
        )
    return _summarize(rows, threshold)


def evaluate_from_csv(analyzer: GIAnalyzer, csv_path: Path, threshold: int = 75) -> dict:
    import pandas as pd

    df = pd.read_csv(csv_path)
    rows = []
    for _, row in df.iterrows():
        text = str(row.get("text") or "")
        if len(text) < 20:
            continue
        task_id = str(row.get("task_id") or "ipophl-other")
        mop = _mop_status(analyzer, text, task_id)
        rf_ok, rf_score = _rf_ready(analyzer, text, threshold)
        mop_ok = mop.lower() == "ready"
        rows.append(
            {
                "file": row.get("source_file") or row.get("sample_id"),
                "task_id": task_id,
                "mop_status": mop,
                "rf_score": rf_score,
                "rf_status": "Ready" if rf_ok else "Not Ready",
                "agrees": mop_ok == rf_ok if rf_score is not None else None,
                "csv_label": row.get("label"),
            }
        )
    return _summarize(rows, threshold)


def _summarize(rows: list[dict], threshold: int) -> dict:
    scored = [r for r in rows if r.get("rf_score") is not None]
    agrees = [r for r in scored if r.get("agrees")]
    summary = {
        "documents_evaluated": len(rows),
        "rf_available": len(scored),
        "agreement_count": len(agrees),
        "agreement_rate": round(len(agrees) / len(scored), 3) if scored else None,
        "rf_threshold": threshold,
        "mop_ready": sum(1 for r in rows if r.get("mop_status") == "Ready"),
        "rf_ready": sum(1 for r in scored if r.get("rf_status") == "Ready"),
    }
    return {"rows": rows, "summary": summary}


def main() -> None:
    parser = argparse.ArgumentParser(description="MoP vs Random Forest agreement report.")
    parser.add_argument("--csv", default="", help="Optional file-dataset CSV path.")
    parser.add_argument("--threshold", type=int, default=75, help="RF Ready threshold (0-100).")
    parser.add_argument("--output", default="", help="Save JSON report path.")
    args = parser.parse_args()

    analyzer = GIAnalyzer(str(ML_DIR / "uploads"))
    if not analyzer.document_model:
        print("WARNING: gi_document_model.joblib not found. Train with:")
        print("  python scripts/build_document_training_data.py --train")

    if args.csv:
        report = evaluate_from_csv(analyzer, Path(args.csv), args.threshold)
    else:
        report = evaluate_from_store(analyzer, args.threshold)

    s = report["summary"]
    print("\n=== MoP vs Random Forest Validation ===")
    print(f"Documents evaluated:  {s.get('documents_evaluated', 0)}")
    print(f"RF model available:   {s.get('rf_available', 0)}")
    print(f"MoP Ready:              {s.get('mop_ready', 0)}")
    print(f"RF Ready (>= {args.threshold}%):  {s.get('rf_ready', 0)}")
    if s.get("agreement_rate") is not None:
        print(f"Agreement rate:       {s['agreement_rate']:.1%} ({s['agreement_count']}/{s['rf_available']})")

    print("\nPer document:")
    for row in report["rows"]:
        flag = "OK" if row.get("agrees") else "MISMATCH"
        rf = row.get("rf_score")
        rf_txt = f"{rf}%" if rf is not None else "n/a"
        print(f"  [{flag}] {row.get('file')} | MoP={row.get('mop_status')} | RF={rf_txt}")

    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nSaved: {out}")


if __name__ == "__main__":
    main()
