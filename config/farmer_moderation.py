"""Farmer account warning / suspend — shared MySQL helpers (Beanthentic-App schema)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any


MOD_COLUMNS: dict[str, str] = {
    "is_suspended": "TINYINT(1) NOT NULL DEFAULT 0",
    "suspended_until": "DATETIME NULL",
    "suspension_reason": "VARCHAR(500) NULL",
    "warning_count": "INT NOT NULL DEFAULT 0",
    "last_warning_at": "DATETIME NULL",
    "last_warning_reason": "VARCHAR(500) NULL",
}


def ensure_farmer_mod_columns(conn) -> None:
    with conn.cursor() as cur:
        for name, col_def in MOD_COLUMNS.items():
            cur.execute(
                """
                SELECT COUNT(*) AS c FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'farmers' AND COLUMN_NAME = %s
                """,
                (name,),
            )
            if int((cur.fetchone() or {}).get("c") or 0) == 0:
                cur.execute(f"ALTER TABLE farmers ADD COLUMN {name} {col_def}")


def clear_expired_suspensions(conn, farmer_id: int | None = None) -> None:
    ensure_farmer_mod_columns(conn)
    sql = """
        UPDATE farmers
        SET is_suspended = 0, suspended_until = NULL, suspension_reason = NULL
        WHERE is_suspended = 1 AND suspended_until IS NOT NULL AND suspended_until <= NOW()
    """
    with conn.cursor() as cur:
        if farmer_id and farmer_id > 0:
            cur.execute(sql + " AND farmer_id = %s", (farmer_id,))
        else:
            cur.execute(sql)


def _parse_until(until) -> datetime | None:
    if until is None or until == "":
        return None
    if isinstance(until, datetime):
        return until
    try:
        return datetime.fromisoformat(str(until).replace("Z", "+00:00").split("+")[0])
    except ValueError:
        pass
    try:
        return datetime.strptime(str(until)[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def farmer_account_status(conn, farmer_id: int) -> dict[str, Any]:
    clear_expired_suspensions(conn, farmer_id)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT is_suspended, suspended_until, suspension_reason,
                   warning_count, last_warning_at, last_warning_reason
            FROM farmers WHERE farmer_id = %s LIMIT 1
            """,
            (farmer_id,),
        )
        row = cur.fetchone() or {}

    is_susp = int(row.get("is_suspended") or 0) == 1
    until_raw = row.get("suspended_until")
    until_dt = _parse_until(until_raw)
    active_susp = False
    if is_susp:
        active_susp = until_dt is None or until_dt > datetime.now()

    until_iso = until_dt.isoformat(sep=" ", timespec="seconds") if until_dt else None
    warned_at = row.get("last_warning_at")
    if warned_at and hasattr(warned_at, "isoformat"):
        warned_at = warned_at.isoformat(sep=" ", timespec="seconds")
    elif warned_at:
        warned_at = str(warned_at)[:19]

    return {
        "is_suspended": active_susp,
        "suspended_until": until_iso,
        "suspension_reason": str(row.get("suspension_reason") or ""),
        "warning_count": int(row.get("warning_count") or 0),
        "last_warning_reason": str(row.get("last_warning_reason") or ""),
        "last_warning_at": warned_at,
    }


def _log_moderation_action(conn, farmer_id: int, action: str, reason: str, expires_at=None) -> None:
    """Optional audit row in farmer_moderation_logs (if table exists)."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id FROM farmers WHERE farmer_id = %s LIMIT 1", (farmer_id,))
            row = cur.fetchone() or {}
            user_id = int(row.get("user_id") or 0)
            if user_id <= 0:
                return
            cur.execute(
                """
                INSERT INTO farmer_moderation_logs (user_id, farmer_id, type, reason, expires_at)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (user_id, farmer_id, action, reason[:500] if reason else None, expires_at),
            )
    except Exception:
        pass


def apply_warning(conn, farmer_id: int, reason: str) -> dict[str, Any]:
    ensure_farmer_mod_columns(conn)
    reason = (reason or "").strip()[:500]
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE farmers
            SET warning_count = warning_count + 1,
                last_warning_at = NOW(),
                last_warning_reason = %s
            WHERE farmer_id = %s
            """,
            (reason, farmer_id),
        )
    _log_moderation_action(conn, farmer_id, "warning", reason)
    return farmer_account_status(conn, farmer_id)


def apply_suspend(conn, farmer_id: int, reason: str, days: int = 3) -> dict[str, Any]:
    ensure_farmer_mod_columns(conn)
    reason = (reason or "").strip()[:500]
    days = max(1, min(int(days or 3), 365))
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE farmers
            SET is_suspended = 1,
                suspended_until = DATE_ADD(NOW(), INTERVAL %s DAY),
                suspension_reason = %s
            WHERE farmer_id = %s
            """,
            (days, reason, farmer_id),
        )
    return farmer_account_status(conn, farmer_id)


def apply_unsuspend(conn, farmer_id: int, _reason: str = "") -> dict[str, Any]:
    ensure_farmer_mod_columns(conn)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE farmers
            SET is_suspended = 0,
                suspended_until = NULL,
                suspension_reason = NULL
            WHERE farmer_id = %s
            """,
            (farmer_id,),
        )
    return farmer_account_status(conn, farmer_id)


def apply_moderation_to_row(farmer_row: dict[str, Any], status: dict[str, Any]) -> None:
    """Merge account_status into dashboard farmer dict."""
    farmer_row["is_blocked"] = bool(status.get("is_suspended"))
    until = status.get("suspended_until")
    if until:
        dt = _parse_until(until)
        farmer_row["suspended_until"] = int(dt.timestamp() * 1000) if dt else None
    else:
        farmer_row["suspended_until"] = None
    farmer_row["suspension_reason"] = status.get("suspension_reason") or ""
    farmer_row["warning_count"] = int(status.get("warning_count") or 0)
    farmer_row["last_warning_reason"] = status.get("last_warning_reason") or ""
