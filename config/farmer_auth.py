"""
Farmer portal: verify phones and update passwords in Beanthentic-App MySQL.
"""

from __future__ import annotations

from werkzeug.security import check_password_hash, generate_password_hash

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

    pwd_hash = generate_password_hash(new_password)

    if beanthentic_env.uses_supabase_anon():
        try:
            from config.supabase_client import get_client

            client = get_client()
            # Prefer password_hash; fall back to password if that is what select uses.
            for col in ("password_hash", "password"):
                try:
                    resp = (
                        client.table("users")
                        .update({col: pwd_hash})
                        .eq("user_id", user_id)
                        .execute()
                    )
                    rows = resp.data if isinstance(getattr(resp, "data", None), list) else []
                    if rows:
                        return True, None
                    # Some PostgREST setups return empty data on update; verify by re-read.
                    check = (
                        client.table("users")
                        .select(col)
                        .eq("user_id", user_id)
                        .limit(1)
                        .execute()
                        .data
                        or []
                    )
                    if check and str(check[0].get(col) or "") == pwd_hash:
                        return True, None
                except Exception:
                    continue
        except Exception:
            pass

    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            return False, "Database is not configured."
        conn = connect_app_db(params)

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


def _password_hash_for_user(user_id: int) -> str | None:
    if user_id <= 0:
        return None
    if beanthentic_env.uses_supabase_anon():
        try:
            from config.supabase_client import get_client

            rows = (
                get_client()
                .table("users")
                .select("password_hash,password")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
                .data
                or []
            )
            if not rows:
                return None
            return str(rows[0].get("password_hash") or rows[0].get("password") or "").strip() or None
        except Exception:
            pass

    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            return None
        conn = connect_app_db(params)
    try:
        col = _find_password_column(conn)
        if not col:
            return None
        with conn.cursor() as cur:
            cur.execute(f"SELECT `{col}` AS pwd FROM users WHERE user_id = %s LIMIT 1", (user_id,))
            row = cur.fetchone()
        if not row:
            return None
        return str(row.get("pwd") or "").strip() or None
    except Exception:
        return None
    finally:
        if conn:
            conn.close()


def _farmer_display_name(farmer: dict) -> str:
    fid = int(farmer.get("farmer_id") or 0)
    digits = str(farmer.get("digits10") or "")
    fallback = f"Farmer +63{digits}" if digits else "Farmer"

    if beanthentic_env.uses_supabase_anon() and fid:
        try:
            from config.supabase_client import get_client

            rows = (
                get_client()
                .table("personal_information")
                .select("first_name,last_name")
                .eq("farmer_id", fid)
                .limit(1)
                .execute()
                .data
                or []
            )
            if rows:
                name = f"{rows[0].get('first_name') or ''} {rows[0].get('last_name') or ''}".strip()
                if name:
                    return name
        except Exception:
            pass
        return fallback

    if not fid:
        return fallback
    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            return fallback
        conn = connect_app_db(params)
    try:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    "SELECT first_name, last_name FROM personal_information WHERE farmer_id = %s LIMIT 1",
                    (fid,),
                )
                row = cur.fetchone()
                if row:
                    name = f"{row.get('first_name') or ''} {row.get('last_name') or ''}".strip()
                    if name:
                        return name
            except Exception:
                try:
                    cur.execute(
                        "SELECT first_name, last_name FROM personal_info WHERE farmer_id = %s LIMIT 1",
                        (fid,),
                    )
                    row = cur.fetchone()
                    if row:
                        name = f"{row.get('first_name') or ''} {row.get('last_name') or ''}".strip()
                        if name:
                            return name
                except Exception:
                    pass
        return fallback
    except Exception:
        return fallback
    finally:
        if conn:
            conn.close()


def authenticate_farmer(phone: str, password: str) -> tuple[dict | None, str | None]:
    """Verify registered farmer phone + password. Name comes from the farmer record."""
    farmer, err = lookup_farmer_by_phone(phone)
    if not farmer:
        return None, err or "Phone number is not registered."
    if not str(password or "").strip():
        return None, "Enter your password."
    stored = _password_hash_for_user(int(farmer.get("user_id") or 0))
    if not stored:
        return None, "No password is set yet. Use Forgot password to create one."
    try:
        ok = check_password_hash(stored, password)
    except Exception:
        ok = False
    if not ok:
        return None, "Incorrect phone number or password."
    farmer["display_name"] = _farmer_display_name(farmer)
    return farmer, None
