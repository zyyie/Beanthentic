"""Persistent admin calendar notes (Supabase REST when configured, JSON fallback)."""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
STORE_PATH = ROOT / "data" / "calendar_notes.json"
_LOCK = threading.Lock()

VALID_CATEGORIES = ("harvest", "delivery", "meeting", "deadline", "other")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _empty_store() -> dict[str, Any]:
    return {"notes_by_date": {}, "updated_at": _now_iso()}


def _supabase_ready() -> bool:
    try:
        import beanthentic_env
        from config.supabase_client import is_configured

        return bool(beanthentic_env.uses_supabase_anon() and is_configured())
    except Exception:
        return False


def _ensure_store() -> dict[str, Any]:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not STORE_PATH.exists():
        data = _empty_store()
        STORE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return data
    try:
        raw = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return _empty_store()
        if "notes_by_date" not in raw or not isinstance(raw["notes_by_date"], dict):
            raw["notes_by_date"] = {}
        return raw
    except Exception:
        return _empty_store()


def _save(data: dict[str, Any]) -> None:
    data["updated_at"] = _now_iso()
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STORE_PATH)


def _normalize_date(date_key: str) -> str | None:
    text = str(date_key or "").strip()
    if len(text) != 10 or text[4] != "-" or text[7] != "-":
        return None
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return None
    return text


def _clean_note(payload: dict[str, Any], *, note_id: str | None = None) -> dict[str, Any]:
    title = str(payload.get("title") or "").strip()[:120]
    body = str(payload.get("body") or "").strip()[:4000]
    category = str(payload.get("category") or "other").strip().lower()
    if category not in VALID_CATEGORIES:
        category = "other"
    if not title and body:
        title = body[:48] + ("…" if len(body) > 48 else "")
    if not title:
        title = "Untitled note"
    return {
        "id": note_id or str(uuid.uuid4()),
        "title": title,
        "body": body,
        "category": category,
        "updated_at": _now_iso(),
        "created_by": str(payload.get("created_by") or "").strip()[:40],
    }


def _row_to_note(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.get("id") or ""),
        "title": str(row.get("title") or ""),
        "body": str(row.get("body") or ""),
        "category": str(row.get("category") or "other"),
        "updated_at": str(row.get("updated_at") or ""),
        "created_by": str(row.get("created_by") or ""),
        "created_at": str(row.get("updated_at") or ""),
    }


def _list_notes_supabase(*, month: str | None = None) -> dict[str, Any] | None:
    try:
        from config.supabase_client import get_client

        client = get_client()
        q = client.table("calendar_notes").select("*").order("note_date").order("updated_at", desc=True)
        if month:
            prefix = str(month).strip()
            if len(prefix) == 7:
                q = q.gte("note_date", f"{prefix}-01").lte("note_date", f"{prefix}-31")
        rows = q.execute().data or []
        by_date: dict[str, list] = {}
        latest = ""
        for row in rows:
            if not isinstance(row, dict):
                continue
            date_key = str(row.get("note_date") or "")[:10]
            if not date_key:
                continue
            note = _row_to_note(row)
            by_date.setdefault(date_key, []).append(note)
            ts = str(row.get("updated_at") or "")
            if ts > latest:
                latest = ts
        return {
            "ok": True,
            "notes_by_date": by_date,
            "updated_at": latest or _now_iso(),
            "categories": list(VALID_CATEGORIES),
            "source": "supabase",
        }
    except Exception:
        return None


def list_notes(*, month: str | None = None) -> dict[str, Any]:
    """Return notes. Optional month filter as YYYY-MM."""
    if _supabase_ready():
        remote = _list_notes_supabase(month=month)
        if remote is not None:
            return remote

    with _LOCK:
        data = _ensure_store()
        by_date = data.get("notes_by_date") or {}
        if month:
            prefix = str(month).strip()
            by_date = {k: v for k, v in by_date.items() if str(k).startswith(prefix)}
        return {
            "ok": True,
            "notes_by_date": by_date,
            "updated_at": data.get("updated_at"),
            "categories": list(VALID_CATEGORIES),
            "source": "json",
        }


def upsert_note(date_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    date_key = _normalize_date(date_key)
    if not date_key:
        return {"ok": False, "error": "Invalid date. Use YYYY-MM-DD."}

    note_id = str(payload.get("id") or "").strip() or None
    note = _clean_note(payload, note_id=note_id)

    if _supabase_ready():
        try:
            from config.supabase_client import get_client

            client = get_client()
            row = {
                "id": note["id"],
                "note_date": date_key,
                "title": note["title"],
                "body": note["body"],
                "category": note["category"],
                "created_by": note.get("created_by") or "",
                "updated_at": note["updated_at"],
            }
            client.table("calendar_notes").upsert(row, on_conflict="id").execute()
            remote = _list_notes_supabase()
            bucket = (remote or {}).get("notes_by_date", {}).get(date_key) or [note]
            return {"ok": True, "date": date_key, "note": note, "notes": bucket, "source": "supabase"}
        except Exception:
            pass

    with _LOCK:
        data = _ensure_store()
        bucket = list(data["notes_by_date"].get(date_key) or [])
        if not isinstance(bucket, list):
            bucket = []
        replaced = False
        for i, existing in enumerate(bucket):
            if str(existing.get("id")) == note["id"]:
                note["created_at"] = existing.get("created_at") or existing.get("updated_at") or _now_iso()
                note["created_by"] = note.get("created_by") or existing.get("created_by") or ""
                bucket[i] = note
                replaced = True
                break
        if not replaced:
            note["created_at"] = _now_iso()
            bucket.append(note)
        bucket.sort(key=lambda n: str(n.get("updated_at") or ""), reverse=True)
        data["notes_by_date"][date_key] = bucket
        _save(data)
        return {"ok": True, "date": date_key, "note": note, "notes": bucket, "source": "json"}


def delete_note(date_key: str, note_id: str) -> dict[str, Any]:
    date_key = _normalize_date(date_key)
    note_id = str(note_id or "").strip()
    if not date_key or not note_id:
        return {"ok": False, "error": "Date and note id are required."}

    if _supabase_ready():
        try:
            from config.supabase_client import get_client

            get_client().table("calendar_notes").delete().eq("id", note_id).execute()
            remote = _list_notes_supabase()
            bucket = (remote or {}).get("notes_by_date", {}).get(date_key) or []
            return {"ok": True, "date": date_key, "notes": bucket, "source": "supabase"}
        except Exception:
            pass

    with _LOCK:
        data = _ensure_store()
        bucket = list(data["notes_by_date"].get(date_key) or [])
        if not isinstance(bucket, list):
            bucket = []
        next_bucket = [n for n in bucket if str(n.get("id")) != note_id]
        if len(next_bucket) == len(bucket):
            return {"ok": False, "error": "Note not found."}
        if next_bucket:
            data["notes_by_date"][date_key] = next_bucket
        else:
            data["notes_by_date"].pop(date_key, None)
        _save(data)
        return {"ok": True, "date": date_key, "notes": next_bucket, "source": "json"}


def store_reachable() -> tuple[bool, str]:
    """Health helper for system-check."""
    if _supabase_ready():
        try:
            from config.supabase_client import get_client

            get_client().table("calendar_notes").select("id").limit(1).execute()
            return True, "supabase calendar_notes reachable"
        except Exception as exc:
            return False, f"supabase calendar_notes: {exc}"
    try:
        with _LOCK:
            _ensure_store()
        return True, f"json store {STORE_PATH.name}"
    except Exception as exc:
        return False, str(exc)
