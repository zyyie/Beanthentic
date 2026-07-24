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
