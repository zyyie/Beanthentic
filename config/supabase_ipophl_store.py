"""Persist IPOPHL document_analysis rows to Supabase via REST (anon key)."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from config.supabase_client import get_client


def _utc_iso(raw) -> str:
    if isinstance(raw, datetime):
        dt = raw
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    text = str(raw or "").strip()
    if not text:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if "T" not in text and " " in text:
        text = text.replace(" ", "T", 1)
    if not text.endswith("Z") and "+" not in text[-6:]:
        text = f"{text}Z"
    return text


def record_to_row(record: dict) -> dict:
    detected = record.get("detected_features")
    missing = record.get("missing_requirements")
    if not isinstance(detected, str):
        detected = json.dumps(detected if isinstance(detected, list) else [])
    if not isinstance(missing, str):
        missing = json.dumps(missing if isinstance(missing, list) else [])

    upload_ts = _utc_iso(record.get("upload_timestamp"))
    analysis_raw = record.get("analysis_timestamp")
    analysis_ts = _utc_iso(analysis_raw) if analysis_raw else upload_ts

    return {
        "file_uuid": str(record.get("file_uuid") or "")[:36],
        "original_filename": str(record.get("original_filename") or "document")[:255],
        "file_path": str(record.get("file_path") or "")[:500],
        "file_type": str(record.get("file_type") or "")[:50],
        "file_size": int(record.get("file_size") or 0),
        "ai_score": int(record.get("ai_score") or 0),
        "ai_status": str(record.get("ai_status") or "Not Ready")[:20],
        "detected_features": detected,
        "missing_requirements": missing,
        "analysis_method": str(record.get("analysis_method") or "rule_based")[:50],
        "text_length": int(record.get("text_length") or 0),
        "shap_analysis": str(record.get("shap_analysis") or ""),
        "upload_timestamp": upload_ts,
        "analysis_timestamp": analysis_ts,
        "ipophl_phase": str(record.get("ipophl_phase") or "")[:50],
        "task_id": str(record.get("task_id") or "")[:100],
    }


def upsert_document_analysis_via_rest(record: dict) -> dict:
    row = record_to_row(record)
    if not row["file_uuid"]:
        raise ValueError("file_uuid is required")
    client = get_client()
    resp = client.table("document_analysis").upsert(row, on_conflict="file_uuid").execute()
    data = resp.data or []
    return data[0] if data else row


def delete_document_analysis_via_rest(file_uuid: str) -> bool:
    uid = str(file_uuid or "").strip()
    if not uid:
        return False
    client = get_client()
    client.table("document_analysis").delete().eq("file_uuid", uid).execute()
    return True


def count_document_analysis_via_rest() -> int:
    client = get_client()
    resp = client.table("document_analysis").select("file_uuid", count="exact").limit(1).execute()
    return int(resp.count or 0)


def sync_records_to_supabase(records: list[dict]) -> tuple[int, list[str]]:
    synced = 0
    errors: list[str] = []
    for rec in records:
        try:
            upsert_document_analysis_via_rest(rec)
            synced += 1
        except Exception as exc:
            uid = str(rec.get("file_uuid") or "?")
            errors.append(f"{uid}: {exc}")
    return synced, errors
