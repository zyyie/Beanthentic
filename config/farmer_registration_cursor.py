"""
Track farmers and notify admin only when registration is fully completed in the app.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from config.farmer_registration_complete import (
    farmer_display_name,
    is_farmer_registration_complete,
)

_CURSOR_PATH = Path(__file__).resolve().parents[1] / "data" / "farmer_registration_cursor.json"


def _load() -> dict[str, Any]:
    if not _CURSOR_PATH.exists():
        return {
            "initialized": False,
            "last_farmer_id": 0,
            "seen_ids": [],
            "notified_complete_ids": [],
        }
    try:
        with open(_CURSOR_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {
                "initialized": False,
                "last_farmer_id": 0,
                "seen_ids": [],
                "notified_complete_ids": [],
            }
        if "notified_complete_ids" not in data:
            # Upgrade: do not re-notify farmers already tracked under the old logic.
            data["notified_complete_ids"] = list(data.get("seen_ids") or [])
        return data
    except (json.JSONDecodeError, OSError):
        return {
            "initialized": False,
            "last_farmer_id": 0,
            "seen_ids": [],
            "notified_complete_ids": [],
        }


def _save(data: dict[str, Any]) -> None:
    _CURSOR_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_CURSOR_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def sync_new_farmer_registrations(rows: list[dict]) -> list[dict]:
    """
    Return farmers who just completed registration (profile + farm data).
    Signup/login with phone only does not trigger a notification.
    """
    if not rows:
        return []

    cursor = _load()
    seen = {int(x) for x in (cursor.get("seen_ids") or []) if str(x).isdigit()}
    notified = {
        int(x) for x in (cursor.get("notified_complete_ids") or []) if str(x).isdigit()
    }
    max_id = max(int(r.get("farmer_id") or r.get("NO.") or 0) for r in rows)

    if not cursor.get("initialized"):
        all_ids = [
            int(r.get("farmer_id") or r.get("NO.") or 0)
            for r in rows
            if int(r.get("farmer_id") or r.get("NO.") or 0)
        ]
        baseline_notified = {
            fid
            for r in rows
            for fid in [int(r.get("farmer_id") or r.get("NO.") or 0)]
            if fid and is_farmer_registration_complete(r)
        }
        _save(
            {
                "initialized": True,
                "last_farmer_id": max_id,
                "seen_ids": sorted(set(all_ids))[-500:],
                "notified_complete_ids": sorted(baseline_notified)[-500:],
            }
        )
        return []

    newly_completed: list[dict] = []
    for r in rows:
        fid = int(r.get("farmer_id") or r.get("NO.") or 0)
        if not fid:
            continue
        if fid not in seen:
            seen.add(fid)
        if not is_farmer_registration_complete(r):
            continue
        if fid in notified:
            continue
        newly_completed.append(r)
        notified.add(fid)

    if not newly_completed and max_id <= int(cursor.get("last_farmer_id") or 0):
        return []

    if newly_completed:
        try:
            from config.utils import log_activity

            for r in newly_completed:
                fid = int(r.get("farmer_id") or r.get("NO.") or 0)
                name = farmer_display_name(r, farmer_id=fid)
                phone = str(
                    r.get("phone_number") or r.get("PHONE") or r.get("contact_number") or ""
                ).strip()
                status = str(r.get("status") or "").strip()
                detail = f"Farmer #{fid} completed registration: {name}"
                if status:
                    detail += f" (status {status})"
                if phone:
                    detail += f" — {phone}"
                log_activity("system", "FARMER_REGISTERED", detail, "")
        except Exception:
            pass

    cursor["initialized"] = True
    cursor["last_farmer_id"] = max(max_id, int(cursor.get("last_farmer_id") or 0))
    cursor["seen_ids"] = sorted(seen)[-500:]
    cursor["notified_complete_ids"] = sorted(notified)[-500:]
    _save(cursor)
    return newly_completed
