"""
Build in-app admin notification feed (messages, transactions, moderation, registrations, etc.).
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from datetime import datetime, timedelta
from typing import Any, Callable

_NOTIF_SOURCE_TIMEOUT_SEC = 3

from config.models import ActivityLogEntry, DocumentAnalysis
from config.utils import get_current_user_phone, load_settings


def _phone_tail(phone: str) -> str:
    d = re.sub(r"\D", "", str(phone or ""))
    if d.startswith("0"):
        d = d[1:]
    if d.startswith("63"):
        d = d[2:]
    return d[-10:] if len(d) >= 10 else d


def _parse_ts(val: Any) -> datetime | None:
    if not val:
        return None
    if isinstance(val, datetime):
        return val
    s = str(val).strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s.replace(" ", "T", 1) if "T" not in s and " " in s else s)
    except ValueError:
        return None


def _item(
    *,
    nid: str,
    icon: str,
    title: str,
    message: str,
    timestamp: datetime | str,
    category: str,
    category_label: str,
    target_module: str,
    ntype: str = "info",
    target_payload: dict | None = None,
    target_id: str = "",
) -> dict:
    ts = timestamp if isinstance(timestamp, datetime) else _parse_ts(timestamp)
    ts_iso = (ts or datetime.now()).isoformat()
    return {
        "id": nid,
        "icon": icon,
        "title": title,
        "message": message,
        "detail": message,
        "timestamp": ts_iso,
        "type": ntype,
        "category": category,
        "category_label": category_label,
        "read": False,
        "target_module": target_module,
        "target_payload": target_payload or {},
        "target_id": target_id,
    }


def _in_app_on(key: str) -> bool:
    settings = load_settings()
    notif = settings.get("notifications") if isinstance(settings.get("notifications"), dict) else {}
    return bool(notif.get(key, True))


def _notifications_messages_local() -> list[dict]:
    """Unread farmer messages from admin SQLite (fast, no LAN)."""
    if not _in_app_on("in_app_system_events"):
        return []
    try:
        from config.models import Message

        rows = (
            Message.query.filter(Message.is_read.is_(False))
            .filter(Message.category != "announcement")
            .order_by(Message.created_at.desc())
            .limit(40)
            .all()
        )
    except Exception:
        return []

    by_farmer: dict[str, dict] = {}
    for m in rows:
        d = m.to_dict() if hasattr(m, "to_dict") else {}
        sender_name = str(d.get("sender_name") or "").strip().lower()
        if sender_name in ("administrator", "admin", "admin user"):
            continue
        if str(d.get("sender_role") or d.get("sender_type") or "").lower() == "admin":
            continue
        phone = str(d.get("sender_phone") or "")
        key = _phone_tail(phone)
        if not key:
            continue
        prev = by_farmer.get(key)
        cur_ts = _parse_ts(d.get("created_at"))
        prev_ts = _parse_ts(prev.get("created_at")) if prev else None
        if not prev or (cur_ts and (not prev_ts or cur_ts > prev_ts)):
            by_farmer[key] = d

    out: list[dict] = []
    for m in by_farmer.values():
        mid = m.get("id")
        name = str(m.get("sender_name") or m.get("sender_phone") or "Farmer").strip()
        body = str(m.get("body") or "")[:160]
        phone = str(m.get("sender_phone") or "")
        out.append(
            _item(
                nid=f"msg-local-{mid}",
                icon="fa-message",
                title=f"New message from {name}",
                message=body or "New farmer message",
                timestamp=m.get("created_at") or datetime.now(),
                category="messages",
                category_label="Messages",
                target_module="messaging",
                ntype="message",
                target_payload={"phone": phone, "messageId": mid},
            )
        )
    return out


def _notifications_messages(admin_phone: str) -> list[dict]:
    if not _in_app_on("in_app_system_events"):
        return []
    local = _notifications_messages_local()
    if local:
        return local
    try:
        from config.messaging_load import load_shared_messages

        items, _unread, _src = load_shared_messages(
            folder="inbox",
            search="",
            category="",
            limit=100,
            role="admin",
            phone=admin_phone or "",
        )
    except Exception:
        return []

    by_farmer: dict[str, dict] = {}
    for m in items:
        if str(m.get("sender_role") or "").lower() != "farmer":
            continue
        if m.get("is_read") in (True, 1, "1"):
            continue
        phone = str(m.get("sender_phone") or "")
        key = _phone_tail(phone)
        if not key:
            continue
        prev = by_farmer.get(key)
        cur_ts = _parse_ts(m.get("created_at"))
        prev_ts = _parse_ts(prev.get("created_at")) if prev else None
        if not prev or (cur_ts and (not prev_ts or cur_ts > prev_ts)):
            by_farmer[key] = m

    out: list[dict] = []
    for m in by_farmer.values():
        mid = m.get("id") or m.get("message_id")
        name = str(m.get("sender_name") or m.get("sender_phone") or "Farmer").strip()
        body = str(m.get("body") or "")[:160]
        phone = str(m.get("sender_phone") or "")
        out.append(
            _item(
                nid=f"msg-{mid}",
                icon="fa-message",
                title=f"New message from {name}",
                message=body or "New farmer message",
                timestamp=m.get("created_at") or datetime.now(),
                category="messages",
                category_label="Messages",
                target_module="messaging",
                ntype="message",
                target_payload={"phone": phone, "messageId": mid},
            )
        )
    return out


def _notifications_transactions() -> list[dict]:
    if not _in_app_on("in_app_system_events"):
        return []
    try:
        from api.transactions_api import load_admin_transactions

        rows, _src = load_admin_transactions(25, None)
    except Exception:
        return []

    cutoff = datetime.now() - timedelta(days=14)
    out: list[dict] = []
    for txn in rows:
        at = _parse_ts(txn.get("recorded_at"))
        if at and at < cutoff:
            continue
        fid = int(txn.get("farmer_id") or 0)
        fname = str(txn.get("farmer_name") or "Farmer").strip()
        product = str(txn.get("product") or txn.get("variety") or "coffee").strip()
        qty = txn.get("qty") or txn.get("delta_kg") or 0
        tid = txn.get("customer_transaction_id") or txn.get("id")
        out.append(
            _item(
                nid=f"txn-{tid}",
                icon="fa-handshake",
                title=f"Transaction: {fname}",
                message=f"{product} · {qty} kg recorded in client history.",
                timestamp=txn.get("recorded_at") or datetime.now(),
                category="transactions",
                category_label="Transactions",
                target_module="transactions",
                ntype="success",
                target_payload={"farmerId": fid, "transactionId": tid},
            )
        )
    return out[:12]


def _notifications_moderation_activity() -> list[dict]:
    if not _in_app_on("in_app_security_breaches"):
        return []
    actions = {
        "FARMER_WARNING": ("fa-triangle-exclamation", "warning", "Farmer warning issued"),
        "FARMER_SUSPEND": ("fa-ban", "alert", "Farmer suspended"),
        "FARMER_UNSUSPEND": ("fa-circle-check", "success", "Farmer unsuspended"),
        "COFFEE_BEAN_TX": ("fa-handshake", "success", "Transaction recorded"),
        "MESSAGE_SENT": ("fa-paper-plane", "info", "Admin message sent"),
    }
    out: list[dict] = []
    try:
        entries = (
            ActivityLogEntry.query.filter(ActivityLogEntry.action.in_(list(actions.keys())))
            .order_by(ActivityLogEntry.timestamp.desc())
            .limit(15)
            .all()
        )
    except Exception:
        return []

    for entry in entries:
        icon, ntype, label = actions.get(str(entry.action or "").upper(), ("fa-gavel", "info", "Moderation"))
        details = str(entry.details or "").strip()
        action_key = str(entry.action or "").upper()
        if action_key == "COFFEE_BEAN_TX":
            cat, cat_label, mod = "transactions", "Transactions", "transactions"
        elif action_key == "MESSAGE_SENT":
            cat, cat_label, mod = "messages", "Messages", "messaging"
        else:
            cat, cat_label, mod = "moderation", "Warning / Suspend", "farmers-list"
        out.append(
            _item(
                nid=f"act-{entry.id or entry.timestamp}",
                icon=icon,
                title=label,
                message=details or "Account moderation action recorded.",
                timestamp=entry.timestamp or datetime.now(),
                category=cat,
                category_label=cat_label,
                target_module=mod,
                ntype=ntype,
                target_payload={"fromActivity": True},
            )
        )
    return out


def _notifications_farmer_moderation_state() -> list[dict]:
    """Farmers currently suspended or recently warned (app DB)."""
    if not _in_app_on("in_app_security_breaches"):
        return []
    try:
        from api.farmer_api import _app_db_connect
        from config.farmer_moderation import ensure_farmer_mod_columns
    except Exception:
        return []

    conn = None
    try:
        conn = _app_db_connect()
        if not conn:
            return []
        ensure_farmer_mod_columns(conn)
        since = datetime.now() - timedelta(days=30)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT f.farmer_id, f.is_suspended, f.warning_count, f.last_warning_at,
                       f.last_warning_reason, f.suspended_until,
                       pi.first_name, pi.last_name
                FROM farmers f
                LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
                WHERE (f.is_suspended = 1 OR COALESCE(f.warning_count, 0) > 0)
                  AND (
                    f.last_warning_at IS NULL
                    OR f.last_warning_at >= %s
                    OR f.is_suspended = 1
                  )
                ORDER BY COALESCE(f.last_warning_at, f.suspended_until) DESC
                LIMIT 12
                """,
                (since,),
            )
            rows = cur.fetchall() or []
    except Exception:
        return []
    finally:
        if conn:
            conn.close()

    out: list[dict] = []
    for r in rows:
        fid = int(r.get("farmer_id") or 0)
        fn = f"{(r.get('first_name') or '').strip()} {(r.get('last_name') or '').strip()}".strip() or f"Farmer #{fid}"
        suspended = int(r.get("is_suspended") or 0) == 1
        wc = int(r.get("warning_count") or 0)
        reason = str(r.get("last_warning_reason") or r.get("suspension_reason") or "").strip()
        if suspended:
            title = f"Suspended: {fn}"
            icon, ntype = "fa-ban", "alert"
            msg = reason or "This farmer account is currently suspended."
        else:
            title = f"Warning on record: {fn}"
            icon, ntype = "fa-triangle-exclamation", "warning"
            msg = reason or f"Active warnings: {wc}"
        out.append(
            _item(
                nid=f"mod-state-{fid}",
                icon=icon,
                title=title,
                message=msg[:200],
                timestamp=r.get("last_warning_at") or datetime.now(),
                category="moderation",
                category_label="Warning / Suspend",
                target_module="farmers-list",
                ntype=ntype,
                target_payload={"farmerId": fid, "farmerNo": fid},
            )
        )
    return out


def _is_postgresql_db(conn) -> bool:
    # Check if connection is PostgreSQL
    try:
        import os
        from pathlib import Path
        import json

        # First check env vars
        db_url = os.getenv("DATABASE_URL", "").strip()
        if db_url.startswith("postgresql://") or db_url.startswith("postgres://"):
            return True

        # Check settings.json
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        if settings_path.exists():
            try:
                settings = json.loads(settings_path.read_text(encoding="utf-8"))
                conn_settings = settings.get("connection", {})
                app_db_url = str(conn_settings.get("app_db_url", "")).strip()
                if app_db_url.startswith("postgresql://") or app_db_url.startswith("postgres://"):
                    return True
                dialect = str(conn_settings.get("app_db_dialect", "")).lower()
                if dialect in ("postgresql", "postgres"):
                    return True
            except Exception:
                pass
    except Exception:
        pass
    return False


def _app_db_column_exists(conn, table: str, column: str) -> bool:
    try:
        with conn.cursor() as cur:
            if _is_postgresql_db(conn):
                cur.execute(
                    """
                    SELECT COUNT(*) AS c
                    FROM information_schema.columns
                    WHERE table_schema = CURRENT_SCHEMA()
                      AND table_name = %s
                      AND column_name = %s
                    """,
                    (table, column),
                )
            else:
                cur.execute(
                    """
                    SELECT COUNT(*) AS c
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = %s
                      AND COLUMN_NAME = %s
                    """,
                    (table, column),
                )
            return int((cur.fetchone() or {}).get("c") or 0) > 0
    except Exception:
        return False


def _load_farmer_rows_for_registrations() -> list[dict]:
    """App DB farmers via MySQL, or HTTP admin_farmer_data.php when LAN MySQL times out."""
    rows: list[dict] = []
    try:
        from api.farmer_api import _app_fetch_farmer_rows, _fetch_farmer_data_via_app_server

        try:
            rows = list(_app_fetch_farmer_rows(limit=2500) or [])
        except Exception:
            rows = []
        if not rows:
            items, _err = _fetch_farmer_data_via_app_server()
            if items:
                rows = list(items)
    except Exception:
        return []
    return rows


def _registration_item_from_row(r: dict, *, nid_prefix: str = "reg-pending") -> dict | None:
    from config.farmer_registration_complete import (
        farmer_display_name,
        is_farmer_registration_complete,
    )

    fid = int(r.get("farmer_id") or r.get("NO.") or 0)
    if not fid or not is_farmer_registration_complete(r):
        return None
    fn = farmer_display_name(r, farmer_id=fid)
    status = str(r.get("status") or "new").strip() or "new"
    reg_ts = _parse_ts(r.get("registered_at") or r.get("created_at")) or datetime.now()
    msg = f"{fn} completed registration. Review in Farmer Records."
    if status:
        msg = f"{msg} Status: {status}."
    return _item(
        nid=f"{nid_prefix}-{fid}",
        icon="fa-user-plus",
        title=f"New farmer registration: {fn}",
        message=msg,
        timestamp=reg_ts,
        category="registrations",
        category_label="Registrations",
        target_module="farmers-list",
        ntype="info",
        target_payload={"farmerId": fid, "farmerNo": fid},
    )


def _notifications_farmer_registration_activity() -> list[dict]:
    """Activity log entries when a farmer registration was recorded."""
    if not _in_app_on("in_app_user_registrations"):
        return []
    actions = (
        "FARMER_REGISTERED",
        "NEW_FARMER",
        "FARMER_SIGNUP",
        "FARMER_REGISTRATION",
        "FARMER_REGISTER",
    )
    out: list[dict] = []
    try:
        entries = (
            ActivityLogEntry.query.filter(ActivityLogEntry.action.in_(actions))
            .order_by(ActivityLogEntry.timestamp.desc())
            .limit(20)
            .all()
        )
    except Exception:
        return []

    for entry in entries:
        details = str(entry.details or "").strip()
        if "completed registration" not in details.lower() and "completed registration:" not in details.lower():
            if "New farmer registration farmer #" in details and ":" not in details.split("#", 1)[-1]:
                continue
        fid = 0
        m = re.search(r"farmer[_\s#]*(\d+)", details, re.I)
        if m:
            fid = int(m.group(1))
        name = ""
        m_name = re.search(r"completed registration:\s*(.+?)(?:\s*\(|$)", details, re.I)
        if m_name:
            name = m_name.group(1).strip()
        elif ":" in details:
            name = details.split(":", 1)[-1].split("(")[0].strip()
        title = f"New farmer registration: {name}" if name else "New farmer registration"
        out.append(
            _item(
                nid=f"reg-act-{entry.id or entry.timestamp}",
                icon="fa-user-plus",
                title=title,
                message=details or "A farmer completed registration in the app.",
                timestamp=entry.timestamp or datetime.now(),
                category="registrations",
                category_label="Registrations",
                target_module="farmers-list",
                ntype="info",
                target_payload={"farmerId": fid, "farmerNo": fid} if fid else {},
            )
        )
    return out


def _notifications_new_farmers() -> list[dict]:
    """Farmers who just completed the app registration wizard (not signup/login only)."""
    if not _in_app_on("in_app_user_registrations"):
        return []
    rows = _load_farmer_rows_for_registrations()
    try:
        from config.farmer_registration_cursor import sync_new_farmer_registrations

        newly_completed = sync_new_farmer_registrations(rows) or []
    except Exception:
        return []

    out: list[dict] = []
    for r in newly_completed:
        item = _registration_item_from_row(r, nid_prefix="reg-pending")
        if item:
            out.append(item)
    return out


def _notifications_misconduct_reports() -> list[dict]:
    if not _in_app_on("in_app_security_breaches"):
        return []
    try:
        from api.client_reports_api import load_admin_client_reports

        items, _src = load_admin_client_reports(20, "under review", "")
    except Exception:
        return []

    out: list[dict] = []
    for r in items:
        status = str(r.get("status") or "").lower()
        if status not in ("under review", "open", ""):
            continue
        rid = r.get("report_id") or r.get("id")
        fname = str(r.get("farmer_name") or "—").strip()
        cat = str(r.get("reason_category") or "Report").strip()
        out.append(
            _item(
                nid=f"report-{rid}",
                icon="fa-gavel",
                title=f"Client report: {fname}",
                message=f"{cat} — needs review.",
                timestamp=r.get("created_at") or datetime.now(),
                category="reports",
                category_label="Client report",
                target_module="client-report",
                ntype="warning",
                target_payload={"reportId": rid, "farmerId": r.get("farmer_id")},
            )
        )
    return out


def _notifications_ipophl() -> list[dict]:
    if not _in_app_on("in_app_system_events"):
        return []
    now = datetime.now()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    out: list[dict] = []
    try:
        recent_docs = (
            DocumentAnalysis.query.filter(DocumentAnalysis.upload_timestamp >= start)
            .order_by(DocumentAnalysis.upload_timestamp.desc())
            .limit(5)
            .all()
        )
    except Exception:
        return []

    for doc in recent_docs:
        score = int(doc.ai_score or 0)
        low = score < 70
        out.append(
            _item(
                nid=f"doc-{doc.file_uuid}",
                icon="fa-file-lines" if not low else "fa-file-circle-exclamation",
                title=f"IPOPHL: {doc.original_filename}",
                message=f"Readiness score: {score}%",
                timestamp=doc.upload_timestamp or now,
                category="ipophl",
                category_label="IPOPHL",
                target_module="ipophl",
                ntype="warning" if low else "success",
            )
        )
    return out


def _notifications_gi_pending() -> list[dict]:
    if not _in_app_on("in_app_system_events"):
        return []
    try:
        from api.gi_contributions_api import load_admin_gi_contributions

        items, _src = load_admin_gi_contributions(40)
    except Exception:
        return []

    out: list[dict] = []
    for row in items:
        status = str(row.get("upload_status") or row.get("status") or "").lower()
        if status != "pending":
            continue
        if len(out) >= 8:
            break
        gid = row.get("id") or row.get("gi_update_id")
        title = str(row.get("title") or "GI update").strip()
        farmer = str(row.get("farmer_name") or row.get("sender_name") or "Farmer").strip()
        out.append(
            _item(
                nid=f"gi-{gid}",
                icon="fa-seedling",
                title=f"GI update pending: {farmer}",
                message=title[:160],
                timestamp=row.get("created_at") or datetime.now(),
                category="gi",
                category_label="GI updates",
                target_module="social-media",
                ntype="info",
                target_payload={"giUpdateId": gid},
            )
        )
    return out


def _safe_notification_source(fn: Callable[[], list[dict]]) -> list[dict]:
    """Prevent one slow LAN DB/HTTP call from blocking the whole feed."""
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            fut = pool.submit(fn)
            return list(fut.result(timeout=_NOTIF_SOURCE_TIMEOUT_SEC) or [])
    except (FuturesTimeout, Exception):
        return []


def build_admin_notifications(*, admin_phone: str | None = None) -> list[dict]:
    """Aggregate all notification sources, newest first (parallel, bounded time)."""
    if admin_phone is None:
        try:
            phone = get_current_user_phone() or ""
        except RuntimeError:
            phone = ""
    else:
        phone = admin_phone

    parts: list[dict] = []
    parts.extend(_notifications_moderation_activity())
    parts.extend(_notifications_ipophl())
    parts.extend(_notifications_messages_local())
    # Farmer registrations: run synchronously (avoid LAN DB timeout hiding new signups)
    parts.extend(_notifications_farmer_registration_activity())
    parts.extend(_notifications_new_farmers())

    remote_sources: list[Callable[[], list[dict]]] = [
        lambda: _notifications_messages(phone),
        _notifications_transactions,
        _notifications_farmer_moderation_state,
        _notifications_misconduct_reports,
        _notifications_gi_pending,
    ]
    try:
        with ThreadPoolExecutor(max_workers=min(6, len(remote_sources))) as pool:
            futures = [pool.submit(_safe_notification_source, fn) for fn in remote_sources]
            for fut in futures:
                try:
                    parts.extend(fut.result(timeout=_NOTIF_SOURCE_TIMEOUT_SEC + 1))
                except FuturesTimeout:
                    continue
    except Exception:
        for fn in remote_sources:
            parts.extend(_safe_notification_source(fn))

    seen: set[str] = set()
    seen_reg_farmers: set[int] = set()
    unique: list[dict] = []
    for n in parts:
        nid = str(n.get("id") or "")
        if not nid or nid in seen:
            continue
        if str(n.get("category") or "") == "registrations":
            payload = n.get("target_payload") if isinstance(n.get("target_payload"), dict) else {}
            fid = int(payload.get("farmerId") or payload.get("farmerNo") or 0)
            if fid and fid in seen_reg_farmers:
                continue
            if fid:
                seen_reg_farmers.add(fid)
        seen.add(nid)
        unique.append(n)

    def sort_key(item: dict) -> datetime:
        return _parse_ts(item.get("timestamp")) or datetime.min

    unique.sort(key=sort_key, reverse=True)
    return unique[:80]
