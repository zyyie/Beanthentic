"""Persist last self-sale / Records unlock audit line per farmer (Supabase + JSON)."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()
_AUDIT_PATH = Path(__file__).resolve().parents[1] / "data" / "self_sale_unlock_audit.json"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _supabase_ready() -> bool:
    try:
        import beanthentic_env
        from config.supabase_client import is_configured

        return bool(beanthentic_env.uses_supabase_anon() and is_configured())
    except Exception:
        return False


def _read_all() -> dict[str, Any]:
    if not _AUDIT_PATH.is_file():
        return {}
    try:
        raw = json.loads(_AUDIT_PATH.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _write_all(payload: dict[str, Any]) -> None:
    _AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = _AUDIT_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_AUDIT_PATH)


def _normalize_entry(fid: int, raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "farmer_id": fid,
        "enabled": bool(raw.get("enabled", True)),
        "unlocked_by": str(raw.get("unlocked_by") or "").strip() or "Admin",
        "unlocked_by_phone": str(raw.get("unlocked_by_phone") or "").strip(),
        "unlocked_at": str(raw.get("unlocked_at") or _utc_now_iso()),
        "pricelist_status": raw.get("pricelist_status"),
        "records_unlocked": bool(raw.get("records_unlocked", raw.get("enabled", True))),
    }


def record_self_sale_unlock(
    farmer_id: int,
    *,
    unlocked_by: str,
    unlocked_by_phone: str = "",
    enabled: bool = True,
) -> dict[str, Any]:
    """Store who unlocked (or last toggled) self-sale and when."""
    fid = int(farmer_id or 0)
    if fid < 1:
        return {}
    entry = {
        "farmer_id": fid,
        "enabled": bool(enabled),
        "unlocked_by": (unlocked_by or unlocked_by_phone or "Admin").strip() or "Admin",
        "unlocked_by_phone": (unlocked_by_phone or "").strip(),
        "unlocked_at": _utc_now_iso(),
        "pricelist_status": "approved" if enabled else None,
        "records_unlocked": bool(enabled),
    }

    if _supabase_ready():
        try:
            from config.supabase_client import get_client

            get_client().table("self_sale_unlock_audit").upsert(entry, on_conflict="farmer_id").execute()
        except Exception:
            pass

    with _LOCK:
        data = _read_all()
        data[str(fid)] = entry
        _write_all(data)
    return entry


def get_self_sale_unlock_audit(farmer_id: int) -> dict[str, Any] | None:
    fid = int(farmer_id or 0)
    if fid < 1:
        return None

    if _supabase_ready():
        try:
            from config.supabase_client import get_client

            rows = (
                get_client()
                .table("self_sale_unlock_audit")
                .select("*")
                .eq("farmer_id", fid)
                .limit(1)
                .execute()
                .data
                or []
            )
            if rows and isinstance(rows[0], dict):
                return _normalize_entry(fid, rows[0])
        except Exception:
            pass

    with _LOCK:
        entry = _read_all().get(str(fid))
    return entry if isinstance(entry, dict) else None


def store_reachable() -> tuple[bool, str]:
    if _supabase_ready():
        try:
            from config.supabase_client import get_client

            get_client().table("self_sale_unlock_audit").select("farmer_id").limit(1).execute()
            return True, "supabase self_sale_unlock_audit reachable"
        except Exception as exc:
            return False, f"supabase self_sale_unlock_audit: {exc}"
    try:
        with _LOCK:
            _read_all()
        return True, f"json store {_AUDIT_PATH.name}"
    except Exception as exc:
        return False, str(exc)
