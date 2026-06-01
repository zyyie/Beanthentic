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
    "ipophl-other": "IPOPHL Document",
}

IPOPHL_TASK_ORDER: list[str] = list(IPOPHL_TASK_LABELS.keys())

# Thirteen IPOPHL upload zones on the dashboard (excludes ipophl-other).
OFFICIAL_IPOPHL_TASK_IDS: list[str] = [
    "phase1-product",
    "phase1-entity",
    "phase1-stakeholders",
    "phase2-mop",
    "phase2-cert",
    "phase2-details",
    "phase3-filing",
    "phase3-payment",
    "phase4-exam",
    "phase4-response",
    "phase4-pub",
    "phase5-cert",
    "phase5-compliance",
]

_TASK_ID_RE = re.compile(r"^phase[1-5]-[a-z0-9-]+$", re.I)


def normalize_ipophl_task_id(raw: str | None) -> str:
    """Validate task_id from upload zone (do not use secure_filename — it is for file names only)."""
    tid = str(raw or "").strip().lower()
    if tid in IPOPHL_TASK_LABELS:
        return tid
    if _TASK_ID_RE.match(tid):
        return tid
    if tid in ("unknown", "ipophl-other", "ipophl-unassigned", ""):
        return "ipophl-other"
    return "ipophl-other"


def apply_task_overrides_to_store(task_overrides: dict[str, str]) -> int:
    """Persist correct upload-zone task_id before publishing to GI Updates."""
    updated = 0
    for raw_uuid, raw_tid in (task_overrides or {}).items():
        file_uuid = str(raw_uuid or "").strip()
        task_id = normalize_ipophl_task_id(raw_tid)
        if not file_uuid or task_id == "ipophl-other":
            continue
        record = get_document(file_uuid)
        if not isinstance(record, dict):
            continue
        phase = task_id.split("-", 1)[0] if task_id.startswith("phase") else record.get("ipophl_phase")
        if record.get("task_id") == task_id and record.get("ipophl_phase") == phase:
            continue
        record["task_id"] = task_id
        record["ipophl_phase"] = phase
        upsert_document(record)
        updated += 1
    return updated


def build_publish_file_entries(
    file_uuids: list[str],
    *,
    task_overrides: dict[str, str] | None = None,
) -> list[dict]:
    """One GI card per file with the correct IPOPHL category title."""
    overrides = task_overrides or {}
    entries: list[dict] = []
    seen_uuids: set[str] = set()

    for raw in file_uuids:
        file_uuid = str(raw or "").strip()
        if not file_uuid or file_uuid in seen_uuids:
            continue
        seen_uuids.add(file_uuid)
        record = get_document(file_uuid)
        task_id = normalize_ipophl_task_id(
            overrides.get(file_uuid) or (record or {}).get("task_id")
        )
        path = resolve_file_path(file_uuid)
        if not path or not path.is_file():
            continue
        name = str((record or {}).get("original_filename") or path.name)
        entries.append(
            {
                "file_uuid": file_uuid,
                "task_id": task_id,
                "label": task_label(task_id),
                "original": name,
                "path": path,
            }
        )

    def sort_key(item: dict) -> tuple[int, int | str]:
        tid = str(item.get("task_id") or "")
        try:
            return (0, IPOPHL_TASK_ORDER.index(tid))
        except ValueError:
            return (1, tid)

    entries.sort(key=sort_key)
    return entries


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
    When the client sends an explicit list, use only those UUIDs (one GI card per file).
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
        return out

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


def build_publish_task_groups(
    file_uuids: list[str],
    *,
    task_overrides: dict[str, str] | None = None,
    include_all_categories: bool = True,
) -> list[dict]:
    """
    One GI Updates card per IPOPHL category (13 groups). Multiple files in the same
    zone are bundled into a single card with multiple attachments.
    """
    grouped = group_disk_files_by_task(file_uuids, task_overrides=task_overrides)
    out: list[dict] = []

    if include_all_categories:
        for task_id in OFFICIAL_IPOPHL_TASK_IDS:
            files = grouped.get(task_id) or []
            out.append(
                {
                    "task_id": task_id,
                    "label": task_label(task_id),
                    "files": files,
                }
            )
        extra = [tid for tid in grouped if tid not in OFFICIAL_IPOPHL_TASK_IDS]
        for task_id in sorted(extra):
            out.append(
                {
                    "task_id": task_id,
                    "label": task_label(task_id),
                    "files": grouped.get(task_id) or [],
                }
            )
        return out

    for task_id, files in grouped.items():
        out.append(
            {
                "task_id": task_id,
                "label": task_label(task_id),
                "files": files,
            }
        )
    return out


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
            "ipophl_phase": "unknown",
            "task_id": "ipophl-other",
        }
        added += 1

    if added:
        _save(data)
    return added


def resolve_file_path(file_uuid: str, *, filename_hint: str | None = None) -> Path | None:
    """Resolve upload path by UUID only (never generic names like uploaded.docx)."""
    _ = filename_hint  # kept for callers; ignored to avoid wrong file matches
    record = get_document(file_uuid)
    if record:
        raw_path = str(record.get("file_path") or "").strip()
        if raw_path:
            path = Path(raw_path)
            if path.is_file():
                return path
            # Relative path or moved project folder
            by_name = UPLOADS_DIR / path.name
            if by_name.is_file():
                return by_name

    if UPLOADS_DIR.exists():
        for candidate in UPLOADS_DIR.glob(f"{file_uuid}.*"):
            if candidate.is_file():
                return candidate
    return None
