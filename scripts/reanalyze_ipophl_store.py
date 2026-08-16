#!/usr/bin/env python3
"""Re-run MoP analysis for all records in data/ipophl_documents.json."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE_PATH = ROOT / "data" / "ipophl_documents.json"

sys.path.insert(0, str(ROOT / "machinelearning"))
sys.path.insert(0, str(ROOT))

from ai_engine import GIAnalyzer  # noqa: E402


def main() -> None:
    if not STORE_PATH.exists():
        print("No ipophl_documents.json found.")
        return

    store = json.loads(STORE_PATH.read_text(encoding="utf-8"))
    analyzer = GIAnalyzer(auto_train=False)
    updated = 0

    for file_uuid, record in store.items():
        if not isinstance(record, dict):
            continue
        from config.ipophl_store import resolve_file_path

        path = resolve_file_path(file_uuid, filename_hint=record.get("original_filename"))
        if not path or not path.exists():
            fp = record.get("file_path", "")
            path = Path(fp) if fp and Path(fp).exists() else None
        if not path or not path.exists():
            print(f"  skip {file_uuid}: file missing")
            continue

        task = record.get("task_id") or "phase1-introduction"
        result = analyzer.analyze_document(str(path), task_id=task)
        if not result.get("success", True):
            print(f"  failed {record.get('original_filename', file_uuid)}: {result.get('error')}")
            continue

        record["ai_score"] = int(result.get("readiness_score") or 0)
        record["ai_status"] = result.get("status") or record.get("ai_status")
        record["detected_features"] = result.get("detected_features") or []
        record["missing_requirements"] = result.get("missing_requirements") or []
        record["analysis_method"] = result.get("analysis_method") or record.get("analysis_method")
        record["text_length"] = int(result.get("text_length") or 0)
        record["shap_analysis"] = result.get("shap_analysis") or ""
        record["score_breakdown"] = result.get("score_breakdown")
        record["ip_pillar_assessment"] = result.get("ip_pillar_assessment")
        record["analysis_timestamp"] = datetime.now(timezone.utc).isoformat()
        if result.get("task_id"):
            record["task_id"] = result["task_id"]
        pf = (result.get("product_focus") or {}).get("off_product_hits") or []
        print(
            f"  ok {record.get('original_filename', file_uuid)} -> "
            f"{record['ai_status']} (off_product: {pf or 'none'})"
        )
        updated += 1

    STORE_PATH.write_text(json.dumps(store, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Updated {updated} document record(s).")


if __name__ == "__main__":
    main()
