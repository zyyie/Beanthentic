"""
Farmer portal: verify phones and update passwords in Beanthentic-App MySQL.
"""

from __future__ import annotations

from werkzeug.security import generate_password_hash

from config.app_connection import app_db_params
from config.mysql_app_bridge import connect_app_db
import beanthentic_env
from config.validation import validate_phone


def _phone_lookup_variants(digits10: str) -> list[str]:
    if len(digits10) != 10:
        return []
    variants = {
        digits10,
        f"0{digits10}",
        f"63{digits10}",
        f"+63{digits10}",
        f"09{digits10[1:]}",
    }
    return [v for v in variants if v]


def _find_password_column(conn) -> str | None:
    with conn.cursor() as cur:
        cur.execute("SHOW COLUMNS FROM users")
        rows = cur.fetchall() or []
    names = []
    for row in rows:
        if isinstance(row, dict):
            names.append(str(row.get("Field") or row.get("field") or ""))
        elif row:
            names.append(str(row[0]))
    lower = {n.lower(): n for n in names if n}
    for candidate in ("password_hash", "password", "pass", "user_password", "pin"):
        if candidate in lower:
            return lower[candidate]
    return None


def _phone_tail(phone: str) -> str:
    import re

    d = re.sub(r"\D", "", str(phone or ""))
    if d.startswith("0"):
        d = d[1:]
    if d.startswith("63"):
        d = d[2:]
    return d


def lookup_farmer_by_phone(phone: str) -> tuple[dict | None, str | None]:
    """
    Return farmer row dict: user_id, farmer_id, phone_number, digits10 — or (None, error).
    """
    ok, err, digits = validate_phone(phone)
    if not ok:
        return None, err

    if beanthentic_env.uses_supabase_anon():
        try:
            from config.supabase_client import get_client

            variants = set(_phone_lookup_variants(digits))
            client = get_client()
            users = client.table("users").select("user_id,phone_number").limit(1000).execute().data or []
            matched_uid = None
            matched_phone = ""
            for u in users:
                p = str(u.get("phone_number") or "")
                if p in variants or _phone_tail(p) == digits:
                    matched_uid = int(u.get("user_id") or 0)
                    matched_phone = p
                    break
            if not matched_uid:
                return None, "This phone number is not registered as a farmer."
            farmers = (
                client.table("farmers")
                .select("farmer_id,user_id")
                .eq("user_id", matched_uid)
                .limit(1)
                .execute()
                .data
                or []
            )
            if not farmers:
                return None, "This phone number is not registered as a farmer."
            fid = int(farmers[0].get("farmer_id") or 0)
            return {
                "farmer_id": fid,
                "user_id": matched_uid,
                "phone_number": matched_phone,
                "digits10": digits,
            }, None
        except Exception:
            pass

    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            return None, "Farmer account lookup is unavailable until the app database is configured."
        conn = connect_app_db(params)

    variants = _phone_lookup_variants(digits)
    placeholders = ", ".join(["%s"] * len(variants))
    sql = f"""
        SELECT f.farmer_id, u.user_id, u.phone_number
        FROM farmers f
        INNER JOIN users u ON u.user_id = f.user_id
        WHERE u.phone_number IN ({placeholders})
           OR RIGHT(REPLACE(REPLACE(REPLACE(TRIM(u.phone_number), ' ', ''), '-', ''), '+', ''), 10) = %s
        LIMIT 1
    """
    try:
        with conn.cursor() as cur:
            cur.execute(sql, (*variants, digits))
            row = cur.fetchone()
        if not row:
            return None, "This phone number is not registered as a farmer."
        return {
            "farmer_id": int(row.get("farmer_id") or 0),
            "user_id": int(row.get("user_id") or 0),
            "phone_number": str(row.get("phone_number") or ""),
            "digits10": digits,
        }, None
    except Exception:
        return None, "Could not verify farmer account. Check database connection."
    finally:
        if conn:
            conn.close()


def is_farmer_phone_registered(phone: str) -> tuple[bool, str | None]:
    row, err = lookup_farmer_by_phone(phone)
    if row:
        return True, None
    return False, err


def update_farmer_password(user_id: int, new_password: str) -> tuple[bool, str | None]:
    """Set password on beanthentic_app.users for the farmer account."""
    if user_id <= 0:
        return False, "Invalid farmer account."

    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            return False, "Database is not configured."
        conn = connect_app_db(params)

    pwd_hash = generate_password_hash(new_password)
    try:
        col = _find_password_column(conn)
        if not col:
            return False, "Users table has no password column. Add password/password_hash in the app database."
        sql = f"UPDATE users SET `{col}` = %s WHERE user_id = %s"
        with conn.cursor() as cur:
            cur.execute(sql, (pwd_hash, user_id))
            if cur.rowcount < 1:
                return False, "Farmer account not found."
        try:
            conn.commit()
        except Exception:
            pass
        return True, None
    except Exception as exc:
        return False, f"Could not update password: {exc}"
    finally:
        if conn:
            conn.close()
