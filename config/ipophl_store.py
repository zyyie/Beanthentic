"""Local JSON persistence for IPOPHL document analysis when MySQL is unavailable."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_STORE_PATH = Path(__file__).resolve().parents[1] / "data" / "ipophl_documents.json"
_DELETED_PATH = Path(__file__).resolve().parents[1] / "data" / "ipophl_deleted.json"
_LOCK = threading.Lock()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z"


def _load_raw() -> dict[str, dict[str, Any]]:
    if not _STORE_PATH.exists():
        return {}
    try:
        data = json.loads(_STORE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict)}


def _save_raw(records: dict[str, dict[str, Any]]) -> None:
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STORE_PATH.write_text(json.dumps(records, indent=2), encoding="utf-8")


def _load_deleted_ids() -> set[str]:
    if not _DELETED_PATH.exists():
        return set()
    try:
        data = json.loads(_DELETED_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return set()
    if isinstance(data, list):
        return {str(x).strip() for x in data if str(x).strip()}
    if isinstance(data, dict):
        ids = data.get("ids")
        if isinstance(ids, list):
            return {str(x).strip() for x in ids if str(x).strip()}
    return set()


def _save_deleted_ids(ids: set[str]) -> None:
    _DELETED_PATH.parent.mkdir(parents=True, exist_ok=True)
    _DELETED_PATH.write_text(json.dumps(sorted(ids), indent=2), encoding="utf-8")


def mark_deleted(file_uuid: str) -> None:
    """Remember admin-deleted ids so disk recovery does not re-import them."""
    file_uuid = str(file_uuid or "").strip()
    if not file_uuid:
        return
    with _LOCK:
        ids = _load_deleted_ids()
        if file_uuid in ids:
            return
        ids.add(file_uuid)
        _save_deleted_ids(ids)


def is_deleted(file_uuid: str) -> bool:
    return str(file_uuid or "").strip() in _load_deleted_ids()


def upsert(record: dict[str, Any]) -> dict[str, Any]:
    """Insert or update a document analysis record keyed by file_uuid."""
    file_uuid = str(record.get("file_uuid") or "").strip()
    if not file_uuid:
        raise ValueError("file_uuid is required")

    with _LOCK:
        records = _load_raw()
        existing = records.get(file_uuid, {})
        merged = {**existing, **record, "file_uuid": file_uuid}
        if not merged.get("upload_timestamp"):
            merged["upload_timestamp"] = _utc_now_iso()
        merged["updated_at"] = _utc_now_iso()
        records[file_uuid] = merged
        _save_raw(records)
        return merged


def get_raw(file_uuid: str) -> dict[str, Any] | None:
    """Read store record even if it is tombstoned (used during delete)."""
    file_uuid = str(file_uuid or "").strip()
    if not file_uuid:
        return None
    with _LOCK:
        return _load_raw().get(file_uuid)


def get(file_uuid: str) -> dict[str, Any] | None:
    file_uuid = str(file_uuid or "").strip()
    if not file_uuid or is_deleted(file_uuid):
        return None
    return get_raw(file_uuid)


def purge(file_uuid: str) -> None:
    """Remove from JSON store and tombstone so the file cannot reappear."""
    file_uuid = str(file_uuid or "").strip()
    if not file_uuid:
        return
    mark_deleted(file_uuid)
    with _LOCK:
        records = _load_raw()
        records.pop(file_uuid, None)
        _save_raw(records)


def delete(file_uuid: str) -> bool:
    file_uuid = str(file_uuid or "").strip()
    if not file_uuid:
        return False
    had = get_raw(file_uuid) is not None
    purge(file_uuid)
    return had


def list_all(*, phase: str | None = None, task_id: str | None = None) -> list[dict[str, Any]]:
    with _LOCK:
        deleted = _load_deleted_ids()
        records = [
            r for r in _load_raw().values()
            if str(r.get("file_uuid") or "").strip() not in deleted
        ]

    if phase:
        records = [r for r in records if r.get("ipophl_phase") == phase]
    if task_id:
        records = [r for r in records if r.get("task_id") == task_id]

    records.sort(key=lambda r: r.get("upload_timestamp") or "", reverse=True)
    return records


def to_list_item(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "file_uuid": record.get("file_uuid"),
        "filename": record.get("original_filename") or record.get("filename"),
        "file_type": record.get("file_type"),
        "file_size": record.get("file_size", 0),
        "upload_timestamp": record.get("upload_timestamp"),
        "ai_score": record.get("ai_score", 0),
        "ai_status": record.get("ai_status", "Not Ready"),
        "ipophl_phase": record.get("ipophl_phase"),
        "task_id": record.get("task_id"),
    }
