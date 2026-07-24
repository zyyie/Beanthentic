"""Load and send shared_messages via Supabase REST."""

from __future__ import annotations

import re
from datetime import datetime

from config.supabase_client import get_client


def _normalize_row(row: dict) -> dict:
    m = dict(row)
    mid = m.get("message_id") or m.get("id")
    if mid is not None:
        m["id"] = int(mid)
        m["message_id"] = int(mid)
    for key in ("sender_role", "recipient_role"):
        if m.get(key) is not None:
            m[key] = str(m[key]).lower()
    if m.get("is_read") is not None:
        m["is_read"] = m["is_read"] in (True, 1, "1", "true")
    return m


def _phone_tail(phone: str) -> str:
    d = re.sub(r"\D", "", str(phone or ""))
    if d.startswith("0"):
        d = d[1:]
    if d.startswith("63"):
        d = d[2:]
    return d


def _phone_matches(a: str, b: str) -> bool:
    ta, tb = _phone_tail(a), _phone_tail(b)
    return bool(ta and tb and ta == tb)


def _matches_folder(row: dict, *, folder: str, role: str, phone: str) -> bool:
    if str(row.get("category") or "").lower() == "announcement":
        return False
    folder = (folder or "inbox").lower()
    role = (role or "admin").lower()
    if folder == "all":
        return True
    if folder == "inbox":
        if role == "admin":
            return (
                str(row.get("recipient_role") or "").lower() == "admin"
                and (not str(row.get("recipient_phone") or "").strip() or _phone_matches(row.get("recipient_phone"), phone))
                and not row.get("is_archived")
            )
        return (
            str(row.get("recipient_role") or "").lower() == "farmer"
            and _phone_matches(row.get("recipient_phone"), phone)
            and not row.get("is_archived")
        )
    if folder == "sent":
        return str(row.get("sender_role") or "").lower() == role and _phone_matches(row.get("sender_phone"), phone)
    if folder == "starred":
        if not row.get("is_starred"):
            return False
        if role == "admin":
            return (
                (str(row.get("recipient_role") or "").lower() == "admin" and (not str(row.get("recipient_phone") or "").strip() or _phone_matches(row.get("recipient_phone"), phone)))
                or (str(row.get("sender_role") or "").lower() == "admin" and _phone_matches(row.get("sender_phone"), phone))
            )
        return (
            (str(row.get("recipient_role") or "").lower() == "farmer" and _phone_matches(row.get("recipient_phone"), phone))
            or (str(row.get("sender_role") or "").lower() == "farmer" and _phone_matches(row.get("sender_phone"), phone))
        )
    if folder == "archived":
        if not row.get("is_archived"):
            return False
        if role == "admin":
            return (
                (str(row.get("recipient_role") or "").lower() == "admin" and (not str(row.get("recipient_phone") or "").strip() or _phone_matches(row.get("recipient_phone"), phone)))
                or (str(row.get("sender_role") or "").lower() == "admin" and _phone_matches(row.get("sender_phone"), phone))
            )
        return (
            (str(row.get("recipient_role") or "").lower() == "farmer" and _phone_matches(row.get("recipient_phone"), phone))
            or (str(row.get("sender_role") or "").lower() == "farmer" and _phone_matches(row.get("sender_phone"), phone))
        )
    return True


def _apply_search(items: list[dict], search: str) -> list[dict]:
    q = (search or "").strip().lower()
    if not q:
        return items
    out: list[dict] = []
    for m in items:
        blob = " ".join(
            str(m.get(k) or "")
            for k in ("subject", "body", "sender_name", "recipient_name", "sender_phone", "recipient_phone")
        ).lower()
        if q in blob:
            out.append(m)
    return out


def list_shared_messages(
    *,
    folder: str,
    search: str = "",
    category: str = "",
    limit: int = 100,
    role: str,
    phone: str,
) -> tuple[list[dict], int]:
    client = get_client()
    resp = (
        client.table("shared_messages")
        .select("*")
        .order("created_at", desc=True)
        .limit(max(limit * 3, 300))
        .execute()
    )
    rows = [_normalize_row(r) for r in (resp.data or []) if isinstance(r, dict)]
    rows = [r for r in rows if _matches_folder(r, folder=folder, role=role, phone=phone)]
    if category:
        rows = [r for r in rows if str(r.get("category") or "").lower() == category.lower()]
    if search:
        rows = _apply_search(rows, search)
    rows = rows[:limit]

    unread = 0
    for r in rows:
        if r.get("is_read"):
            continue
        if role == "admin" and str(r.get("recipient_role") or "").lower() == "admin":
            unread += 1
        elif role == "farmer" and str(r.get("recipient_role") or "").lower() == "farmer" and _phone_matches(r.get("recipient_phone"), phone):
            unread += 1
    return rows, unread


def unread_count(*, role: str, phone: str) -> int:
    client = get_client()
    resp = client.table("shared_messages").select("recipient_role,recipient_phone,is_read,is_archived,category").execute()
    count = 0
    for row in resp.data or []:
        if not isinstance(row, dict):
            continue
        if str(row.get("category") or "").lower() == "announcement":
            continue
        if row.get("is_read") or row.get("is_archived"):
            continue
        if role == "admin" and str(row.get("recipient_role") or "").lower() == "admin":
            rp = str(row.get("recipient_phone") or "").strip()
            if not rp or _phone_matches(rp, phone):
                count += 1
        elif role == "farmer" and str(row.get("recipient_role") or "").lower() == "farmer":
            if _phone_matches(row.get("recipient_phone"), phone):
                count += 1
    return count


def list_thread(farmer_phone: str) -> list[dict]:
    phone = str(farmer_phone or "").strip()
    if not phone:
        return []
    client = get_client()
    resp = (
        client.table("shared_messages")
        .select("*")
        .order("created_at")
        .limit(500)
        .execute()
    )
    rows = []
    for row in resp.data or []:
        if not isinstance(row, dict):
            continue
        if str(row.get("category") or "").lower() == "announcement":
            continue
        if _phone_matches(row.get("sender_phone"), phone) or _phone_matches(row.get("recipient_phone"), phone):
            rows.append(_normalize_row(row))
    return rows


def send_message(
    *,
    role: str,
    phone: str,
    sender_name: str,
    recipient_role: str,
    recipient_phone: str,
    recipient_name: str,
    subject: str,
    body: str,
    category: str,
    farmer_id: int | None,
) -> dict:
    payload = {
        "sender_role": role,
        "sender_phone": phone,
        "sender_name": sender_name,
        "recipient_role": recipient_role,
        "recipient_phone": recipient_phone,
        "recipient_name": recipient_name,
        "subject": subject,
        "body": body,
        "category": (category or "general")[:30],
        "farmer_id": farmer_id,
        "is_read": False,
        "is_starred": False,
        "is_archived": False,
        "created_at": datetime.utcnow().isoformat(),
    }
    client = get_client()
    resp = client.table("shared_messages").insert(payload).execute()
    row = (resp.data or [{}])[0] if resp.data else {}
    return _normalize_row(row) if row else {"id": 0, **payload}
