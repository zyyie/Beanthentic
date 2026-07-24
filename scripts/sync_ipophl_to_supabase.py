"""Backfill local IPOPHL JSON metadata into Supabase document_analysis."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config.ipophl_store import list_documents, upsert_payload_from_model  # noqa: E402
from config.supabase_ipophl_store import (  # noqa: E402
    count_document_analysis_via_rest,
    sync_records_to_supabase,
)
from types import SimpleNamespace  # noqa: E402


def _record_from_json(doc: dict) -> dict:
    from config.ipophl_store import analysis_payload_from_record

    analysis = analysis_payload_from_record(doc)
    ns = SimpleNamespace(
        file_uuid=doc.get("file_uuid", ""),
        original_filename=doc.get("original_filename") or doc.get("filename", "document"),
        file_path=doc.get("file_path", ""),
        file_type=doc.get("file_type", ""),
        file_size=int(doc.get("file_size") or 0),
        ipophl_phase=doc.get("ipophl_phase", ""),
        task_id=doc.get("task_id", ""),
        ai_score=int(doc.get("ai_score") or analysis.get("readiness_score") or 0),
        ai_status=doc.get("ai_status") or analysis.get("status") or "Not Ready",
        detected_features_list=analysis.get("detected_features") or doc.get("detected_features") or [],
        missing_requirements_list=analysis.get("missing_requirements") or doc.get("missing_requirements") or [],
        analysis_method=doc.get("analysis_method") or analysis.get("analysis_method") or "rule_based",
        text_length=int(doc.get("text_length") or analysis.get("text_length") or 0),
        shap_analysis=doc.get("shap_analysis") or analysis.get("shap_analysis") or "",
        upload_timestamp=doc.get("upload_timestamp"),
        analysis_timestamp=doc.get("analysis_timestamp") or analysis.get("analysis_timestamp"),
    )
    return upsert_payload_from_model(ns)


def main() -> int:
    before = count_document_analysis_via_rest()
    docs = list_documents(limit=500)
    records = [_record_from_json(d) for d in docs]
    synced, errors = sync_records_to_supabase(records)
    after = count_document_analysis_via_rest()
    print(f"Local JSON docs: {len(docs)}")
    print(f"Synced to Supabase: {synced}")
    print(f"document_analysis count: {before} -> {after}")
    if errors:
        print("Errors:")
        for line in errors[:20]:
            print(" ", line)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
