"""
JSON fallback store for IPOPHL document metadata when MySQL is unavailable.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

_UUID_FILE_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$",
    re.I,
)
_ALLOWED_UPLOAD_SUFFIXES = frozenset({".pdf", ".doc", ".docx", ".txt", ".md", ".csv"})

STORE_PATH = Path(__file__).resolve().parent.parent / "data" / "ipophl_documents.json"
UPLOADS_DIR = Path(__file__).resolve().parent.parent / "machinelearning" / "uploads"

# Matches IPOPHL dashboard h4 titles (one GI Updates card per category).
IPOPHL_TASK_LABELS: dict[str, str] = {
    "phase1-product": "Product Documentation",
    "phase1-entity": "Entity Documentation",
    "phase1-stakeholders": "Consultation Records",
    "phase2-mop": "MOP Documentation",
    "phase2-cert": "Certification Documents",
    "phase2-details": "Application Package",
    "phase3-filing": "Filing Documents",
    "phase3-payment": "Payment Documentation",
    "phase4-exam": "Examination Documents",
    "phase4-response": "Response Documents",
    "phase4-pub": "Publication Documents",
    "phase5-cert": "Registration Documents",
    "phase5-compliance": "Compliance Documentation",
}

IPOPHL_TASK_ORDER: list[str] = list(IPOPHL_TASK_LABELS.keys())


def _load() -> dict:
    if not STORE_PATH.exists():
        return {}
    try:
        raw = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except json.JSONDecodeError:
        return {}


def _save(data: dict) -> None:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STORE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def upsert_document(record: dict) -> None:
    file_uuid = str(record.get("file_uuid") or "").strip()
    if not file_uuid:
        return
    data = _load()
    data[file_uuid] = record
    _save(data)


def get_document(file_uuid: str) -> dict | None:
    file_uuid = str(file_uuid or "").strip()
    if not file_uuid:
        return None
    record = _load().get(file_uuid)
    return record if isinstance(record, dict) else None


def delete_document(file_uuid: str) -> None:
    file_uuid = str(file_uuid or "").strip()
    if not file_uuid:
        return
    data = _load()
    if file_uuid in data:
        data.pop(file_uuid, None)
        _save(data)


def collect_registration_file_uuids(
    *,
    file_uuids: list[str] | None = None,
    task_ids: list[str] | None = None,
) -> list[str]:
    """
    Resolve file UUIDs for Complete Registration.
    Phase 5 uploads may be stored under phase5-* or legacy/wrong task_id — gather all candidates.
    """
    bootstrap_orphan_uploads(limit=500)
    seen: set[str] = set()
    out: list[str] = []

    def add(raw: str | None) -> None:
        uid = str(raw or "").strip()
        if uid and uid not in seen:
            seen.add(uid)
            out.append(uid)

    if file_uuids:
        for raw in file_uuids:
            add(raw)

    phase5_tasks = task_ids or ["phase5-cert", "phase5-compliance"]
    for tid in phase5_tasks:
        for record in list_documents(task_id=str(tid).strip(), limit=50):
            add(str(record.get("file_uuid") or ""))

    for record in list_documents(phase="phase5", limit=50):
        add(str(record.get("file_uuid") or ""))

    for record in list_documents(limit=300):
        tid = str(record.get("task_id") or "")
        if tid.startswith("phase5-"):
            add(str(record.get("file_uuid") or ""))

    # Complete registration: include every uploaded IPOPHL file (all phases / categories).
    for record in list_documents(limit=300):
        add(str(record.get("file_uuid") or ""))

    return out


def task_label(task_id: str) -> str:
    tid = str(task_id or "").strip()
    if tid in IPOPHL_TASK_LABELS:
        return IPOPHL_TASK_LABELS[tid]
    if tid.startswith("phase") and "-" in tid:
        suffix = tid.split("-", 1)[-1].replace("-", " ").strip()
        return suffix.title() + " Documentation" if suffix else "IPOPHL Document"
    return "IPOPHL Document"


def group_disk_files_by_task(
    file_uuids: list[str],
    *,
    task_overrides: dict[str, str] | None = None,
) -> dict[str, list[tuple[str, Path]]]:
    """Group resolved upload paths by IPOPHL task_id for separate GI Update cards."""
    groups: dict[str, list[tuple[str, Path]]] = {}
    seen_paths: set[str] = set()

    for raw in file_uuids:
        file_uuid = str(raw or "").strip()
        if not file_uuid:
            continue
        record = get_document(file_uuid)
        task_id = str((task_overrides or {}).get(file_uuid) or "").strip()
        if not task_id:
            task_id = str((record or {}).get("task_id") or "ipophl-other").strip() or "ipophl-other"
        hint = str((record or {}).get("original_filename") or "") if record else None
        path = resolve_file_path(file_uuid, filename_hint=hint or None)
        if not path or not path.is_file():
            continue
        key = path.resolve().as_posix()
        if key in seen_paths:
            continue
        seen_paths.add(key)
        name = str((record or {}).get("original_filename") or path.name)
        groups.setdefault(task_id, []).append((name, path))

    def sort_key(tid: str) -> tuple[int, int | str]:
        try:
            return (0, IPOPHL_TASK_ORDER.index(tid))
        except ValueError:
            return (1, tid)

    return dict(sorted(groups.items(), key=lambda item: sort_key(item[0])))


def list_documents(*, phase: str | None = None, task_id: str | None = None, limit: int = 200) -> list[dict]:
    items = list(_load().values())
    items = [item for item in items if isinstance(item, dict)]
    if phase:
        items = [item for item in items if str(item.get("ipophl_phase") or "") == phase]
    if task_id:
        items = [item for item in items if str(item.get("task_id") or "") == task_id]
    items.sort(key=lambda item: str(item.get("upload_timestamp") or ""), reverse=True)
    return items[: max(1, min(limit, 500))]


def document_to_item(record: dict) -> dict:
    return {
        "file_uuid": record.get("file_uuid"),
        "filename": record.get("original_filename") or record.get("filename") or "Uploaded file",
        "file_type": record.get("file_type") or "",
        "file_size": int(record.get("file_size") or 0),
        "upload_timestamp": record.get("upload_timestamp") or datetime.utcnow().isoformat(timespec="seconds"),
        "ai_score": int(record.get("ai_score") or 0),
        "ai_status": record.get("ai_status") or "Not Ready",
        "ipophl_phase": record.get("ipophl_phase") or "unknown",
        "task_id": record.get("task_id") or "unknown",
    }


def analysis_payload_from_record(record: dict) -> dict:
    detected = record.get("detected_features") or []
    missing = record.get("missing_requirements") or []
    if isinstance(detected, str):
        try:
            detected = json.loads(detected)
        except json.JSONDecodeError:
            detected = []
    if isinstance(missing, str):
        try:
            missing = json.loads(missing)
        except json.JSONDecodeError:
            missing = []
    return {
        "readiness_score": int(record.get("ai_score") or 0),
        "status": record.get("ai_status") or "Not Ready",
        "detected_features": detected if isinstance(detected, list) else [],
        "missing_requirements": missing if isinstance(missing, list) else [],
        "analysis_method": record.get("analysis_method") or "rule_based",
        "text_length": int(record.get("text_length") or 0),
        "shap_analysis": record.get("shap_analysis") or "",
        "analysis_timestamp": record.get("analysis_timestamp"),
    }


def bootstrap_orphan_uploads(*, limit: int = 500) -> int:
    """Register on-disk upload files that are missing from the JSON store."""
    if not UPLOADS_DIR.exists():
        return 0

    data = _load()
    added = 0
    candidates = sorted(
        (path for path in UPLOADS_DIR.iterdir() if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )

    for candidate in candidates:
        if added >= limit:
            break
        if not _UUID_FILE_RE.match(candidate.name):
            continue

        file_uuid = candidate.stem
        if file_uuid in data:
            continue

        ext = candidate.suffix.lower()
        if ext not in _ALLOWED_UPLOAD_SUFFIXES:
            continue

        stat = candidate.stat()
        data[file_uuid] = {
            "file_uuid": file_uuid,
            "original_filename": f"uploaded{ext}",
            "file_path": candidate.as_posix(),
            "file_type": ext,
            "file_size": stat.st_size,
            "ai_score": 10,
            "ai_status": "Uploaded - pending review",
            "detected_features": [],
            "missing_requirements": [],
            "analysis_method": "disk_bootstrap",
            "text_length": 0,
            "shap_analysis": "Recovered from uploads folder",
            "upload_timestamp": datetime.utcfromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
            "analysis_timestamp": datetime.utcfromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
            "ipophl_phase": "phase1",
            "task_id": "phase1-product",
        }
        added += 1

    if added:
        _save(data)
    return added


def resolve_file_path(file_uuid: str, *, filename_hint: str | None = None) -> Path | None:
    record = get_document(file_uuid)
    if record:
        path = Path(str(record.get("file_path") or ""))
        if path.exists():
            return path

    if UPLOADS_DIR.exists():
        for candidate in UPLOADS_DIR.glob(f"{file_uuid}.*"):
            if candidate.is_file():
                return candidate
        if filename_hint:
            for candidate in UPLOADS_DIR.glob(f"*{Path(filename_hint).name}"):
                if candidate.is_file():
                    return candidate
    return None
