"""Load GI farmer contributions via Supabase REST."""

from __future__ import annotations

from config.supabase_client import supabase_rest_get

_CHUNK = 100


def _chunks(values: list, size: int = _CHUNK):
    for i in range(0, len(values), size):
        yield values[i : i + size]


def _fetch_by_ids(table: str, key: str, ids: list[int]) -> dict[int, dict]:
    if not ids:
        return {}
    unique = list(dict.fromkeys(int(i) for i in ids if int(i or 0) > 0))
    out: dict[int, dict] = {}
    for batch in _chunks(unique):
        expr = f"in.({','.join(str(i) for i in batch)})"
        rows = supabase_rest_get(table, filters={key: expr})
        for row in rows:
            rid = row.get(key)
            if rid is not None:
                out[int(rid)] = row
    return out


def fetch_gi_contributions_via_rest(limit: int = 500, *, phase: str | None = None) -> list[dict]:
    limit = max(1, min(int(limit or 500), 2000))
    phase_key = (phase or "inbox").lower()

    if phase_key in ("sent", "admin_submission"):
        rows = supabase_rest_get(
            "gi_updates",
            order="created_at.desc",
            limit=limit,
            filters={"current_phase": "eq.admin_submission"},
        )
    else:
        raw_rows = supabase_rest_get(
            "gi_farmers_contribution",
            order="created_at.desc",
            limit=limit,
        )
        rows = []
        for row in raw_rows:
            if not isinstance(row, dict):
                continue
            gid = int(row.get("gi_farmer_contribution_id") or row.get("gi_update_id") or 0)
            rows.append(
                {
                    **row,
                    "gi_update_id": gid,
                    "current_phase": "farmer_submission",
                }
            )

    if not rows:
        return []

    farmer_ids = [int(r["farmer_id"]) for r in rows if r.get("farmer_id")]
    farmers_by_id = _fetch_by_ids("farmers", "farmer_id", farmer_ids)
    user_ids = [int(f["user_id"]) for f in farmers_by_id.values() if f.get("user_id")]
    users_by_id = _fetch_by_ids("users", "user_id", user_ids)
    pi_by_fid = _fetch_by_ids("personal_information", "farmer_id", farmer_ids)

    out: list[dict] = []
    for row in rows:
        fid = int(row.get("farmer_id") or 0)
        farmer = farmers_by_id.get(fid) or {}
        user = users_by_id.get(int(farmer.get("user_id") or 0)) or {}
        pi = pi_by_fid.get(fid) or {}
        fn = str(pi.get("first_name") or "").strip()
        ln = str(pi.get("last_name") or "").strip()
        farmer_name = (fn + " " + ln).strip() or str(row.get("sender_name") or "Farmer")
        out.append(
            {
                **row,
                "email": user.get("email"),
                "username": user.get("username"),
                "phone_number": user.get("phone_number"),
                "first_name": fn,
                "last_name": ln,
                "farmer_name": farmer_name,
            }
        )
    return out


def list_active_farmer_ids_via_rest(limit: int = 5000) -> list[int]:
    """Farmer IDs for GI broadcast — Supabase REST (no BEANTHENTIC_DB_URL)."""
    from config.supabase_client import get_client

    client = get_client()
    resp = (
        client.table("farmers")
        .select("farmer_id")
        .order("farmer_id")
        .limit(max(1, min(int(limit or 5000), 10000)))
        .execute()
    )
    ids: list[int] = []
    for row in resp.data or []:
        if not isinstance(row, dict):
            continue
        try:
            fid = int(row.get("farmer_id") or 0)
        except (TypeError, ValueError):
            fid = 0
        if fid > 0:
            ids.append(fid)
    return sorted(set(ids))


def delete_ipophl_gi_updates_by_categories_via_rest(
    categories: list[str],
    *,
    sender_name: str,
) -> int:
    """Remove prior IPOPHL admin GI cards via REST."""
    cats = [str(c or "").strip()[:30] for c in categories if str(c or "").strip()]
    if not cats:
        return 0
    from config.supabase_client import get_client

    client = get_client()
    removed = 0
    try:
        resp = (
            client.table("gi_updates")
            .delete()
            .eq("current_phase", "admin_submission")
            .eq("sender_name", sender_name)
            .in_("category", cats)
            .execute()
        )
        removed = len(resp.data or []) if isinstance(resp.data, list) else 0
    except Exception:
        for cat in cats:
            try:
                resp = (
                    client.table("gi_updates")
                    .delete()
                    .eq("current_phase", "admin_submission")
                    .eq("sender_name", sender_name)
                    .eq("category", cat)
                    .execute()
                )
                removed += len(resp.data or []) if isinstance(resp.data, list) else 0
            except Exception:
                continue
    return removed


def broadcast_admin_submissions_via_rest(
    *,
    farmer_ids: list[int],
    title: str,
    content: str,
    category: str,
    attachments: list[dict],
    sender_name: str,
) -> list[int]:
    """Insert admin_submission GI Update rows for each farmer via Supabase REST."""
    import json

    from config.supabase_client import get_client

    if not farmer_ids:
        raise RuntimeError("No farmers found in the database.")

    preview = " ".join(str(content or "").split())[:200]
    attachments_json = json.dumps(attachments) if attachments else None
    cat = (category or "general")[:30]
    client = get_client()
    created_ids: list[int] = []

    rows = [
        {
            "farmer_id": int(fid),
            "current_phase": "admin_submission",
            "title": str(title or "")[:150],
            "content": content,
            "preview": preview,
            "category": cat,
            "sender_name": str(sender_name or "Administrator")[:255],
            "attachments_json": attachments_json,
            "upload_status": "approved",
            "is_starred": False,
            "is_read_admin": True,
            "progress_percent": 0,
        }
        for fid in farmer_ids
    ]

    chunk = 50
    for i in range(0, len(rows), chunk):
        batch = rows[i : i + chunk]
        resp = client.table("gi_updates").insert(batch).execute()
        for row in resp.data or []:
            if not isinstance(row, dict):
                continue
            try:
                gid = int(row.get("gi_update_id") or 0)
            except (TypeError, ValueError):
                gid = 0
            if gid > 0:
                created_ids.append(gid)

    if not created_ids and rows:
        # Prefer header Prefer: return=representation usually returns rows; if RLS
        # hides RETURNING, treat insert as success when no exception was raised.
        return [0] * len(farmer_ids)
    if created_ids and len(created_ids) != len(farmer_ids):
        raise RuntimeError(
            f"GI broadcast incomplete: created {len(created_ids)} of {len(farmer_ids)} farmer rows."
        )
    return created_ids


def set_gi_progress_via_rest(
    farmer_ids: list[int],
    *,
    progress_percent: float,
    note: str,
    sender_name: str,
) -> None:
    """Write admin_progress rows so the app GI progress bar updates."""
    from config.supabase_client import get_client

    if not farmer_ids:
        return
    client = get_client()
    body_note = note or f"GI Registration — {progress_percent:.0f}%"
    rows = [
        {
            "farmer_id": int(fid),
            "current_phase": "admin_progress",
            "title": "GI Process Update",
            "content": body_note,
            "preview": body_note[:200],
            "category": "gi_progress",
            "sender_name": str(sender_name or "IPOPHL Administrator")[:255],
            "upload_status": "approved",
            "is_starred": False,
            "is_read_admin": True,
            "progress_percent": float(progress_percent),
        }
        for fid in farmer_ids
    ]
    chunk = 50
    for i in range(0, len(rows), chunk):
        client.table("gi_updates").insert(rows[i : i + chunk]).execute()


def probe_supabase_rest() -> tuple[bool, str]:
    """True when anon REST can read farmers (Complete Registration preflight)."""
    try:
        from config.supabase_client import verify_connection

        return verify_connection()
    except Exception as exc:
        return False, str(exc)
