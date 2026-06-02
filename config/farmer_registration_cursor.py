"""
Track which app-database farmer_ids have already triggered admin registration notifications.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_CURSOR_PATH = Path(__file__).resolve().parents[1] / "data" / "farmer_registration_cursor.json"


def _load() -> dict[str, Any]:
    if not _CURSOR_PATH.exists():
        return {"initialized": False, "last_farmer_id": 0, "seen_ids": []}
    try:
        with open(_CURSOR_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"initialized": False, "last_farmer_id": 0, "seen_ids": []}
        return data
    except (json.JSONDecodeError, OSError):
        return {"initialized": False, "last_farmer_id": 0, "seen_ids": []}


def _save(data: dict[str, Any]) -> None:
    _CURSOR_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_CURSOR_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def sync_new_farmer_registrations(rows: list[dict]) -> list[dict]:
    """
    Detect farmers with farmer_id not yet seen; log FARMER_REGISTERED for admin notifications.
    On first run, baseline cursor without logging (avoids flooding history).
    """
    if not rows:
        return []

    cursor = _load()
    seen = {int(x) for x in (cursor.get("seen_ids") or []) if str(x).isdigit()}
    max_id = max(int(r.get("farmer_id") or 0) for r in rows)

    if not cursor.get("initialized"):
        all_ids = [int(r.get("farmer_id") or 0) for r in rows if int(r.get("farmer_id") or 0)]
        _save(
            {
                "initialized": True,
                "last_farmer_id": max_id,
                "seen_ids": sorted(set(all_ids))[-500:],
            }
        )
        return []

    newcomers: list[dict] = []
    for r in rows:
        fid = int(r.get("farmer_id") or 0)
        if not fid or fid in seen:
            continue
        newcomers.append(r)
        seen.add(fid)

    if not newcomers:
        if max_id > int(cursor.get("last_farmer_id") or 0):
            cursor["last_farmer_id"] = max_id
            cursor["seen_ids"] = sorted(seen)[-500:]
            _save(cursor)
        return []

    try:
        from config.utils import log_activity

        for r in newcomers:
            fid = int(r.get("farmer_id") or 0)
            first = (r.get("first_name") or "").strip()
            last = (r.get("last_name") or "").strip()
            name = f"{first} {last}".strip() or f"Farmer #{fid}"
            phone = str(r.get("phone_number") or r.get("contact_number") or "").strip()
            status = str(r.get("status") or "new").strip()
            detail = f"New farmer registration farmer #{fid}: {name}"
            if phone:
                detail += f" (phone {phone})"
            if status:
                detail += f" — status {status}"
            log_activity("system", "FARMER_REGISTERED", detail, "")
    except Exception:
        pass

    cursor["initialized"] = True
    cursor["last_farmer_id"] = max(max_id, int(cursor.get("last_farmer_id") or 0))
    cursor["seen_ids"] = sorted(seen)[-500:]
    _save(cursor)
    return newcomers
