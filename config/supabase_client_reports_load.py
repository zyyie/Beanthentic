"""Load and update client misconduct reports via Supabase REST."""

from __future__ import annotations

from config.supabase_client import get_client


def _normalize_status(status: str) -> str:
    s = (status or "under review").strip().lower().replace("_", " ")
    if s == "open":
        return "under review"
    return s


def fetch_client_reports_via_rest(limit: int = 500, status: str = "", q: str = "") -> list[dict]:
    limit = max(1, min(int(limit or 500), 2000))
    client = get_client()
    resp = (
        client.table("client_misconduct_report")
        .select("*")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    rows = [r for r in (resp.data or []) if isinstance(r, dict)]
    if status:
        want = _normalize_status(status)
        rows = [r for r in rows if _normalize_status(str(r.get("status") or "")) == want]
    if q:
        needle = q.strip().lower()
        filtered = []
        for r in rows:
            blob = " ".join(
                str(r.get(k) or "")
                for k in ("reporter_name", "reporter_contact", "farmer_name", "reason_category", "reason_detail", "allegation")
            ).lower()
            if needle in blob:
                filtered.append(r)
        rows = filtered
    return rows[:limit]


def update_client_report_status_via_rest(
    report_id: int, status: str, resolution_note: str = ""
) -> dict:
    client = get_client()
    status = _normalize_status(status)
    payload: dict = {"status": status}
    note = str(resolution_note or "").strip()
    if note:
        payload["resolution_note"] = note
    try:
        resp = (
            client.table("client_misconduct_report")
            .update(payload)
            .eq("report_id", int(report_id))
            .execute()
        )
    except Exception:
        # Column may not exist yet — fall back to status-only update.
        resp = (
            client.table("client_misconduct_report")
            .update({"status": status})
            .eq("report_id", int(report_id))
            .execute()
        )
    rows = resp.data or []
    if not rows:
        check = client.table("client_misconduct_report").select("*").eq("report_id", int(report_id)).limit(1).execute()
        rows = check.data or []
    if not rows:
        raise LookupError("Report not found")
    row = dict(rows[0])
    if note and not row.get("resolution_note"):
        row["resolution_note"] = note
    return row
