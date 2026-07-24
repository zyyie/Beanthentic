"""
Beanthentic-App admin HTTP bridges (run on the device that hosts port 8080).

Copy this file next to app.py on the app server, then in app.py add:

    try:
        from admin_bridges import register_admin_bridges
        register_admin_bridges(app)
    except ImportError:
        pass

Requires: pip install psycopg2-binary (for Supabase/PostgreSQL) OR pymysql (for MySQL)
"""

from __future__ import annotations

import base64
import os
import re
from typing import Any

from flask import Response, jsonify, request

# Try to import both PostgreSQL and MySQL drivers
try:
    import psycopg2
    from psycopg2.extras import DictCursor as Psycopg2DictCursor
except ImportError:
    psycopg2 = None  # type: ignore

try:
    import pymysql
    from pymysql.cursors import DictCursor as PyMySQLDictCursor
except ImportError:
    pymysql = None  # type: ignore

PHOTO_CANDIDATES = (
    "profile_photo_data",
    "profile_photo",
    "profile_picture",
    "photo",
    "photo_path",
    "avatar",
    "image_url",
    "profile_image",
    "user_photo",
    "selfie",
    "profile_pic",
)

_TABLES = (
    ("users", "u", "LEFT JOIN users u ON u.user_id = f.user_id"),
    (
        "personal_information",
        "pi",
        "LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id",
    ),
    ("farmers", "f2", "LEFT JOIN farmers f2 ON f2.farmer_id = f.farmer_id"),
)


def _db_params() -> dict[str, Any]:
    # Check for full PostgreSQL URL first (for Supabase)
    db_url = os.getenv("BEANTHENTIC_DB_URL", "").strip()
    if db_url:
        return {"url": db_url}
    
    # Fall back to individual parameters (supports both PostgreSQL and MySQL)
    db_type = os.getenv("BEANTHENTIC_DB_TYPE", "postgresql").strip().lower()
    return {
        "type": db_type,
        "host": os.getenv("BEANTHENTIC_DB_HOST", "127.0.0.1"),
        "port": int(os.getenv("BEANTHENTIC_DB_PORT", "5432" if db_type == "postgresql" else "3306")),
        "user": os.getenv("BEANTHENTIC_DB_USER", "postgres"),
        "password": os.getenv("BEANTHENTIC_DB_PASS", ""),
        "database": os.getenv("BEANTHENTIC_DB_NAME", "postgres"),
    }


def _connect():
    params = _db_params()
    
    # If we have a full URL, use that (for Supabase)
    if "url" in params:
        if psycopg2 is None:
            raise RuntimeError("psycopg2-binary is not installed on the app server")
        return psycopg2.connect(params["url"], cursor_factory=Psycopg2DictCursor)
    
    # Otherwise use individual parameters
    if params["type"] == "postgresql":
        if psycopg2 is None:
            raise RuntimeError("psycopg2-binary is not installed on the app server")
        return psycopg2.connect(
            host=params["host"],
            port=params["port"],
            user=params["user"],
            password=params["password"],
            dbname=params["database"],
            cursor_factory=Psycopg2DictCursor
        )
    else:  # MySQL
        if pymysql is None:
            raise RuntimeError("pymysql is not installed on the app server")
        return pymysql.connect(
            host=params["host"],
            port=params["port"],
            user=params["user"],
            password=params["password"],
            database=params["database"],
            charset="utf8mb4",
            cursorclass=PyMySQLDictCursor,
            connect_timeout=8,
            read_timeout=12,
            write_timeout=12
        )


def _table_columns(cur, table: str) -> dict[str, str]:
    params = _db_params()
    
    # Different queries for PostgreSQL vs MySQL information_schema
    if "url" in params or params.get("type") == "postgresql":
        cur.execute(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = CURRENT_SCHEMA() AND table_name = %s
            """,
            (table,),
        )
    else:
        cur.execute(
            """
            SELECT COLUMN_NAME, DATA_TYPE
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
            """,
            (table,),
        )
    
    out: dict[str, str] = {}
    for row in cur.fetchall() or []:
        if "url" in params or params.get("type") == "postgresql":
            name = str(row.get("column_name") or "").lower()
            if name:
                out[name] = str(row.get("data_type") or "").lower()
        else:
            name = str(row.get("COLUMN_NAME") or "").lower()
            if name:
                out[name] = str(row.get("DATA_TYPE") or "").lower()
    return out


def _pick_photo_column(cols: dict[str, str]) -> str | None:
    for candidate in PHOTO_CANDIDATES:
        if candidate in cols:
            return candidate
    return None


def _mime_from_bytes(raw: bytes) -> str:
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if len(raw) > 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def _normalize_data_url(text: str) -> str | None:
    s = (text or "").strip()
    if not s:
        return None
    if s.startswith("data:image/"):
        return s
    if s.startswith("/9j/") or s.startswith("iVBOR"):
        mime = "image/jpeg" if s.startswith("/9j/") else "image/png"
        return f"data:{mime};base64,{s}"
    return None


def _resolve_upload_path(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s or re.match(r"^https?://", s, re.I):
        return None
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
    candidates = []
    if s.startswith("/"):
        candidates.append(os.path.join(root, s.lstrip("/")))
    candidates.append(os.path.join(root, s.lstrip("/")))
    base = os.path.basename(s)
    if base and ".." not in base:
        for folder in (
            "uploads/farmers",
            "uploads/profiles",
            "uploads/profile_photos",
            "uploads",
            "static/uploads",
            "android-app/app/src/main/assets/uploads",
        ):
            candidates.append(os.path.join(root, folder, base))
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def _photo_record_for_farmer(cur, farmer_id: int) -> dict[str, Any] | None:
    fid = int(farmer_id or 0)
    if fid < 1:
        return None
    for table, alias, join_sql in _TABLES:
        cols = _table_columns(cur, table)
        col = _pick_photo_column(cols)
        if not col:
            continue
        cur.execute(
            f"""
            SELECT {alias}.{col} AS photo_value
            FROM farmers f
            {join_sql}
            WHERE f.farmer_id = %s
            LIMIT 1
            """,
            (fid,),
        )
        row = cur.fetchone()
        if not row or row.get("photo_value") in (None, ""):
            continue
        raw = row["photo_value"]
        col_type = cols.get(col, "")
        if isinstance(raw, (bytes, bytearray)):
            data = bytes(raw)
            if len(data) < 16:
                continue
            return {"kind": "bytes", "value": data, "mime": _mime_from_bytes(data)}
        text = str(raw).strip()
        if not text:
            continue
        data_url = _normalize_data_url(text)
        if data_url:
            return {"kind": "data_url", "value": data_url}
        if re.match(r"^https?://", text, re.I):
            return {"kind": "url", "value": text}
        path = _resolve_upload_path(text)
        if path:
            return {"kind": "path", "value": path}
    return None


def _response_from_record(rec: dict[str, Any]) -> Response:
    kind = rec.get("kind")
    if kind == "bytes":
        return Response(
            rec["value"],
            mimetype=str(rec.get("mime") or "image/jpeg"),
            headers={"Cache-Control": "public, max-age=3600"},
        )
    if kind == "path":
        with open(rec["value"], "rb") as fh:
            body = fh.read()
        ext = os.path.splitext(rec["value"])[1].lower()
        mime = {
            ".png": "image/png",
            ".gif": "image/gif",
            ".webp": "image/webp",
        }.get(ext, "image/jpeg")
        return Response(body, mimetype=mime, headers={"Cache-Control": "public, max-age=3600"})
    if kind == "url":
        return Response("", status=302, headers={"Location": rec["value"]})
    if kind == "data_url":
        m = re.match(r"^data:(image/[^;]+);base64,(.+)$", rec["value"], re.I | re.S)
        if not m:
            return jsonify({"ok": False, "error": "invalid_data_url"}), 400
        body = base64.b64decode(m.group(2))
        return Response(
            body,
            mimetype=m.group(1),
            headers={"Cache-Control": "public, max-age=3600"},
        )
    return jsonify({"ok": False, "error": "unsupported_photo"}), 400


def _ensure_shared_messages_table(conn):
    params = _db_params()
    is_pg = "url" in params or params.get("type") == "postgresql"
    with conn.cursor() as cur:
        if is_pg:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS shared_messages (
                  message_id BIGSERIAL PRIMARY KEY,
                  sender_role VARCHAR(20) NOT NULL CHECK (sender_role IN ('admin','farmer')),
                  sender_phone VARCHAR(32) NOT NULL,
                  sender_name VARCHAR(255),
                  recipient_role VARCHAR(20) NOT NULL CHECK (recipient_role IN ('admin','farmer')),
                  recipient_phone VARCHAR(32) NOT NULL DEFAULT '',
                  recipient_name VARCHAR(255),
                  subject VARCHAR(300) NOT NULL,
                  body TEXT NOT NULL,
                  category VARCHAR(30) NOT NULL DEFAULT 'general',
                  farmer_id BIGINT,
                  is_read BOOLEAN NOT NULL DEFAULT FALSE,
                  is_starred BOOLEAN NOT NULL DEFAULT FALSE,
                  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  read_at TIMESTAMPTZ
                );
                CREATE INDEX IF NOT EXISTS idx_sm_recipient ON shared_messages (recipient_role, recipient_phone, is_read, is_archived);
                CREATE INDEX IF NOT EXISTS idx_sm_sender ON shared_messages (sender_role, sender_phone);
                CREATE INDEX IF NOT EXISTS idx_sm_created ON shared_messages (created_at);
                """
            )
        else:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS shared_messages (
                  message_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                  sender_role ENUM('admin','farmer') NOT NULL,
                  sender_phone VARCHAR(32) NOT NULL,
                  sender_name VARCHAR(255) NULL,
                  recipient_role ENUM('admin','farmer') NOT NULL,
                  recipient_phone VARCHAR(32) NOT NULL DEFAULT '',
                  recipient_name VARCHAR(255) NULL,
                  subject VARCHAR(300) NOT NULL,
                  body TEXT NOT NULL,
                  category VARCHAR(30) NOT NULL DEFAULT 'general',
                  farmer_id BIGINT UNSIGNED NULL,
                  is_read TINYINT(1) NOT NULL DEFAULT 0,
                  is_starred TINYINT(1) NOT NULL DEFAULT 0,
                  is_archived TINYINT(1) NOT NULL DEFAULT 0,
                  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  read_at DATETIME NULL,
                  INDEX idx_sm_recipient (recipient_role, recipient_phone, is_read, is_archived),
                  INDEX idx_sm_sender (sender_role, sender_phone),
                  INDEX idx_sm_created (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                """
            )
    conn.commit()


def _normalize_shared_message_row(row):
    if not row:
        return row
    m = dict(row)
    for key in ("sender_role", "recipient_role"):
        if m.get(key) is not None:
            m[key] = str(m[key]).lower()
    created = m.get("created_at")
    if created is not None and hasattr(created, "isoformat"):
        m["created_at"] = created.isoformat()
    read_at = m.get("read_at")
    if read_at is not None and hasattr(read_at, "isoformat"):
        m["read_at"] = read_at.isoformat()
    if m.get("is_read") is not None:
        m["is_read"] = m["is_read"] in (True, 1, "1")
    return m


def _is_postgresql_db() -> bool:
    params = _db_params()
    if "url" in params:
        return True
    return params.get("type") == "postgresql"


def _mod_table_columns(cur, table: str) -> set[str]:
    if _is_postgresql_db():
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = CURRENT_SCHEMA() AND table_name = %s
            """,
            (table,),
        )
    else:
        cur.execute(
            """
            SELECT COLUMN_NAME
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
            """,
            (table,),
        )
    rows = cur.fetchall()
    out: set[str] = set()
    for row in rows:
        out.add(row["column_name"] if isinstance(row, dict) else row[0])
    return out


def _mod_farmer_pk_column(cur) -> str:
    cols = _mod_table_columns(cur, "farmers")
    if "farmer_id" in cols:
        return "farmer_id"
    return "id"


def _get_mod_columns() -> dict[str, str]:
    if _is_postgresql_db():
        return {
            "is_suspended": "BOOLEAN NOT NULL DEFAULT FALSE",
            "suspended_until": "TIMESTAMPTZ NULL",
            "suspension_reason": "VARCHAR(500) NULL",
            "warning_count": "INT NOT NULL DEFAULT 0",
            "last_warning_at": "TIMESTAMPTZ NULL",
            "last_warning_reason": "VARCHAR(500) NULL",
        }
    return {
        "is_suspended": "TINYINT(1) NOT NULL DEFAULT 0",
        "suspended_until": "DATETIME NULL",
        "suspension_reason": "VARCHAR(500) NULL",
        "warning_count": "INT NOT NULL DEFAULT 0",
        "last_warning_at": "DATETIME NULL",
        "last_warning_reason": "VARCHAR(500) NULL",
    }


def ensure_farmer_mod_columns(conn) -> None:
    try:
        # Rollback any existing transaction before checking
        if _is_postgresql_db():
            try:
                conn.rollback()
            except Exception:
                pass
        mod_columns = _get_mod_columns()
        with conn.cursor() as cur:
            for name, col_def in mod_columns.items():
                if _is_postgresql_db():
                    cur.execute(
                        """
                        SELECT COUNT(*) AS c FROM information_schema.columns
                        WHERE table_schema = CURRENT_SCHEMA() AND table_name = 'farmers' AND column_name = %s
                        """,
                        (name,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT COUNT(*) AS c FROM information_schema.COLUMNS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'farmers' AND COLUMN_NAME = %s
                        """,
                        (name,),
                    )
                if int((cur.fetchone() or {}).get("c") or 0) == 0:
                    cur.execute(f"ALTER TABLE farmers ADD COLUMN {name} {col_def}")
    except Exception as e:
        # If we fail to add columns (probably because they exist already), just ignore
        pass


def clear_expired_suspensions(conn, farmer_id: int | None = None) -> None:
    ensure_farmer_mod_columns(conn)
    is_postgres = _is_postgresql_db()
    now_func = "CURRENT_TIMESTAMP" if is_postgres else "NOW()"
    sql = f"""
        UPDATE farmers
        SET is_suspended = {'FALSE' if is_postgres else '0'}, suspended_until = NULL, suspension_reason = NULL
        WHERE is_suspended = {'TRUE' if is_postgres else '1'} AND suspended_until IS NOT NULL AND suspended_until <= {now_func}
    """
    with conn.cursor() as cur:
        if farmer_id and farmer_id > 0:
            fk = _mod_farmer_pk_column(cur)
            cur.execute(sql + f" AND {fk} = %s", (farmer_id,))
        else:
            cur.execute(sql)


def _mod_parse_until(until) -> datetime | None:
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
        fk = _mod_farmer_pk_column(cur)
        cur.execute(
            f"""
            SELECT is_suspended, suspended_until, suspension_reason,
                   warning_count, last_warning_at, last_warning_reason
            FROM farmers WHERE {fk} = %s LIMIT 1
            """,
            (farmer_id,),
        )
        row = cur.fetchone() or {}

    is_susp = int(row.get("is_suspended") or 0) == 1
    until_raw = row.get("suspended_until")
    until_dt = _mod_parse_until(until_raw)
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


def _mod_log_moderation_action(conn, farmer_id: int, action: str, reason: str, expires_at=None) -> None:
    """Optional audit row in farmer_moderation_logs (if table exists)."""
    try:
        with conn.cursor() as cur:
            fk = _mod_farmer_pk_column(cur)
            cur.execute(f"SELECT user_id FROM farmers WHERE {fk} = %s LIMIT 1", (farmer_id,))
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
    is_postgres = _is_postgresql_db()
    now_func = "CURRENT_TIMESTAMP" if is_postgres else "NOW()"
    with conn.cursor() as cur:
        fk = _mod_farmer_pk_column(cur)
        cur.execute(
            f"""
            UPDATE farmers
            SET warning_count = warning_count + 1,
                last_warning_at = {now_func},
                last_warning_reason = %s
            WHERE {fk} = %s
            """,
            (reason, farmer_id),
        )
    _mod_log_moderation_action(conn, farmer_id, "warning", reason)
    return farmer_account_status(conn, farmer_id)


def apply_suspend(conn, farmer_id: int, reason: str, days: int = 3) -> dict[str, Any]:
    ensure_farmer_mod_columns(conn)
    reason = (reason or "").strip()[:500]
    days = max(1, min(int(days or 3), 365))
    is_postgres = _is_postgresql_db()
    now_func = "CURRENT_TIMESTAMP" if is_postgres else "NOW()"
    interval_clause = f"CURRENT_TIMESTAMP + INTERVAL '{days} days'" if is_postgres else f"DATE_ADD(NOW(), INTERVAL %s DAY)"
    with conn.cursor() as cur:
        fk = _mod_farmer_pk_column(cur)
        if is_postgres:
            cur.execute(
                f"""
                UPDATE farmers
                SET is_suspended = TRUE,
                    suspended_until = {interval_clause},
                    suspension_reason = %s
                WHERE {fk} = %s
                """,
                (reason, farmer_id),
            )
        else:
            cur.execute(
                f"""
                UPDATE farmers
                SET is_suspended = 1,
                    suspended_until = {interval_clause},
                    suspension_reason = %s
                WHERE {fk} = %s
                """,
                (days, reason, farmer_id),
            )
    return farmer_account_status(conn, farmer_id)


def apply_unsuspend(conn, farmer_id: int, _reason: str = "") -> dict[str, Any]:
    ensure_farmer_mod_columns(conn)
    is_postgres = _is_postgresql_db()
    with conn.cursor() as cur:
        fk = _mod_farmer_pk_column(cur)
        cur.execute(
            f"""
            UPDATE farmers
            SET is_suspended = {'FALSE' if is_postgres else '0'},
                suspended_until = NULL,
                suspension_reason = NULL
            WHERE {fk} = %s
            """,
            (farmer_id,),
        )
    return farmer_account_status(conn, farmer_id)


def register_admin_bridges(app) -> None:
    """Register routes that mirror deploy/xampp_api/*.php for Flask app.py on :8080."""

    @app.route("/api/admin_farmer_profile_photo.php", methods=["GET"])
    def admin_farmer_profile_photo():
        farmer_id = int(request.args.get("farmer_id") or 0)
        if farmer_id < 1:
            return jsonify({"ok": False, "error": "farmer_id required"}), 400
        try:
            conn = _connect()
            with conn.cursor() as cur:
                rec = _photo_record_for_farmer(cur, farmer_id)
            conn.close()
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 503
        if not rec:
            return jsonify({"ok": False, "error": "no_photo"}), 404
        return _response_from_record(rec)

    @app.route("/api/admin_farmer_photos.php", methods=["GET"])
    @app.route("/api/admin_farmer_photos", methods=["GET"])
    def admin_farmer_photos_manifest():
        """JSON manifest: farmer_id -> data URL (for admin dashboard cards)."""
        try:
            conn = _connect()
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT farmer_id FROM farmers WHERE farmer_id IS NOT NULL ORDER BY farmer_id ASC"
                )
                ids = [
                    int(r.get("farmer_id") or 0)
                    for r in (cur.fetchall() or [])
                    if int(r.get("farmer_id") or 0) > 0
                ]
                items = []
                for fid in ids:
                    rec = _photo_record_for_farmer(cur, fid)
                    if not rec:
                        continue
                    if rec.get("kind") == "data_url":
                        photo = rec["value"]
                    elif rec.get("kind") == "bytes":
                        mime = rec.get("mime") or "image/jpeg"
                        b64 = base64.b64encode(rec["value"]).decode("ascii")
                        photo = f"data:{mime};base64,{b64}"
                    elif rec.get("kind") == "path":
                        with open(rec["value"], "rb") as fh:
                            raw = fh.read()
                        ext = os.path.splitext(rec["value"])[1].lower()
                        mime = {
                            ".png": "image/png",
                            ".gif": "image/gif",
                            ".webp": "image/webp",
                        }.get(ext, "image/jpeg")
                        photo = f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
                    elif rec.get("kind") == "url":
                        photo = rec["value"]
                    else:
                        continue
                    items.append({"farmer_id": fid, "photo": photo})
            conn.close()
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 503
        return jsonify({"ok": True, "items": items, "count": len(items)})

    @app.route("/api/admin_send_message.php", methods=["POST"])
    def admin_send_message():
        try:
            conn = _connect()
            _ensure_shared_messages_table(conn)
            data = request.get_json(silent=True) or request.form or {}
            params = _db_params()
            is_pg = "url" in params or params.get("type") == "postgresql"
            with conn.cursor() as cur:
                sender_phone = str(data.get("sender_phone") or "")
                sender_name = str(data.get("sender_name") or sender_phone)
                recipient_phone = str(data.get("recipient_phone") or "")
                recipient_name = str(data.get("recipient_name") or recipient_phone)
                subject = str(data.get("subject") or "Message")
                body = str(data.get("body") or "")
                category = str(data.get("category") or "general")[:30]
                farmer_id = data.get("farmer_id")
                farmer_id = int(farmer_id) if farmer_id and str(farmer_id).isdigit() else None
                
                # Determine roles: if sending to admin (recipient_phone empty), sender is farmer; else admin to farmer
                if recipient_phone == "":
                    sender_role = "farmer"
                    recipient_role = "admin"
                else:
                    # Assume if recipient is not admin, it's admin sending to farmer
                    sender_role = "admin"
                    recipient_role = "farmer"
                
                if is_pg:
                    cur.execute(
                        """
                        INSERT INTO shared_messages
                          (sender_role, sender_phone, sender_name,
                           recipient_role, recipient_phone, recipient_name,
                           subject, body, category, farmer_id,
                           is_read, is_starred, is_archived)
                        VALUES
                          (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, FALSE, FALSE)
                        RETURNING message_id
                        """,
                        (
                            sender_role,
                            sender_phone,
                            sender_name,
                            recipient_role,
                            recipient_phone,
                            recipient_name,
                            subject,
                            body,
                            category,
                            farmer_id,
                        ),
                    )
                    mid = int(cur.fetchone()["message_id"])
                else:
                    cur.execute(
                        """
                        INSERT INTO shared_messages
                          (sender_role, sender_phone, sender_name,
                           recipient_role, recipient_phone, recipient_name,
                           subject, body, category, farmer_id,
                           is_read, is_starred, is_archived)
                        VALUES
                          (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0, 0, 0)
                        """,
                        (
                            sender_role,
                            sender_phone,
                            sender_name,
                            recipient_role,
                            recipient_phone,
                            recipient_name,
                            subject,
                            body,
                            category,
                            farmer_id,
                        ),
                    )
                    mid = int(cur.lastrowid)
            conn.commit()
            conn.close()
            return jsonify({"ok": True, "message_id": mid, "message": {"id": mid, "body": body, "sender_name": sender_name}})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 503

    @app.route("/api/admin_shared_messages.php", methods=["GET", "POST"])
    def admin_shared_messages():
        try:
            conn = _connect()
            _ensure_shared_messages_table(conn)
            params = _db_params()
            is_pg = "url" in params or params.get("type") == "postgresql"
            folder = request.args.get("folder", "all")
            limit = int(request.args.get("limit", 100))
            search = (request.args.get("search") or "").lower()
            category = (request.args.get("category") or "").lower()
            role = (request.args.get("role") or "admin").lower()
            phone = (request.args.get("phone") or "")
            
            with conn.cursor() as cur:
                # Build WHERE clause
                where = ["LOWER(category) <> 'announcement'"]
                args = []
                false_val = "FALSE" if is_pg else "0"
                true_val = "TRUE" if is_pg else "1"
                
                if folder == "all":
                    where.append("(sender_role = 'farmer' OR recipient_role = 'farmer' OR sender_role = 'admin' OR recipient_role = 'admin')")
                elif folder == "inbox":
                    if role == "admin":
                        where.append(f"recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s) AND is_archived={false_val}")
                        args.append(phone)
                    else:
                        where.append(f"recipient_role='farmer' AND recipient_phone=%s AND is_archived={false_val}")
                        args.append(phone)
                elif folder == "sent":
                    where.append("sender_role=%s AND sender_phone=%s")
                    args.extend([role, phone])
                elif folder == "starred":
                    if role == "admin":
                        where.append(f"((recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s)) OR (sender_role='admin' AND sender_phone=%s)) AND is_starred={true_val}")
                        args.extend([phone, phone])
                    else:
                        where.append(f"((recipient_role='farmer' AND recipient_phone=%s) OR (sender_role='farmer' AND sender_phone=%s)) AND is_starred={true_val}")
                        args.extend([phone, phone])
                elif folder == "archived":
                    if role == "admin":
                        where.append(f"recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s) AND is_archived={true_val}")
                        args.append(phone)
                    else:
                        where.append(f"recipient_role='farmer' AND recipient_phone=%s AND is_archived={true_val}")
                        args.append(phone)
                
                if category:
                    where.append("category=%s")
                    args.append(category)
                
                where_sql = " AND ".join(where)
                
                cur.execute(
                    f"""
                    SELECT message_id AS id, sender_phone, sender_name,
                      recipient_phone, recipient_name, subject, body, category, farmer_id,
                      is_read, is_starred, is_archived, created_at, read_at,
                      sender_role, recipient_role
                    FROM shared_messages
                    WHERE {where_sql}
                    ORDER BY created_at DESC, message_id DESC
                    LIMIT %s
                    """,
                    tuple(args + [limit]),
                )
                items = [_normalize_shared_message_row(m) for m in (cur.fetchall() or [])]
                
                # Apply search filter in Python
                if search:
                    items = [
                        m for m in items
                        if search in (str(m.get("subject") or "").lower())
                        or search in (str(m.get("body") or "").lower())
                        or search in (str(m.get("sender_name") or "").lower())
                        or search in (str(m.get("recipient_name") or "").lower())
                    ]
                
                # Calculate unread count
                unread_count = 0
                if role == "admin":
                    cur.execute(
                        f"""
                        SELECT COUNT(*) AS c FROM shared_messages
                        WHERE recipient_role='admin'
                          AND (recipient_phone='' OR recipient_phone=%s)
                          AND sender_role='farmer' AND is_read={false_val} AND is_archived={false_val}
                          AND LOWER(category) <> 'announcement'
                        """,
                        (phone,),
                    )
                else:
                    cur.execute(
                        f"""
                        SELECT COUNT(*) AS c FROM shared_messages
                        WHERE recipient_role='farmer' AND recipient_phone=%s
                          AND is_read={false_val} AND is_archived={false_val}
                          AND LOWER(category) <> 'announcement'
                        """,
                        (phone,),
                    )
                unread_count = int((cur.fetchone() or {}).get("c") or 0)
            
            conn.close()
            return jsonify({"ok": True, "items": items, "unread_count": unread_count})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 503
            
    @app.route("/api/chat_thread.php", methods=["GET"])
    def chat_thread():
        try:
            conn = _connect()
            _ensure_shared_messages_table(conn)
            params = _db_params()
            is_pg = "url" in params or params.get("type") == "postgresql"
            farmer_phone = request.args.get("phone", "") or request.args.get("user_id", "")
            
            if not farmer_phone:
                return jsonify({"ok": True, "items": []})
            
            # Simple phone variants matching
            def phone_variants(phone):
                d = re.sub(r"\D", "", str(phone))
                variants = []
                if phone.strip():
                    variants.append(phone.strip())
                if d:
                    variants.extend([d, f"+{d}"])
                    if d.startswith("63") and len(d) >= 12:
                        variants.append("0" + d[2:])
                    elif d.startswith("0") and len(d) >= 11:
                        variants.append("+63" + d[1:])
                return list(dict.fromkeys(v for v in variants if v))
                
            variants = phone_variants(farmer_phone)
            if not variants:
                return jsonify({"ok": True, "items": []})
            
            with conn.cursor() as cur:
                ph = ", ".join(["%s"] * len(variants))
                cur.execute(
                    f"""
                    SELECT message_id AS id, sender_phone, sender_name,
                      recipient_phone, recipient_name, subject, body, category, farmer_id,
                      is_read, is_starred, is_archived, created_at, read_at,
                      sender_role, recipient_role
                    FROM shared_messages
                    WHERE LOWER(category) <> 'announcement'
                      AND (
                        (sender_role='farmer' AND sender_phone IN ({ph}))
                        OR (recipient_role='farmer' AND recipient_phone IN ({ph}))
                      )
                    ORDER BY created_at ASC, message_id ASC
                    LIMIT 500
                    """,
                    tuple(variants + variants),
                )
                items = [_normalize_shared_message_row(m) for m in (cur.fetchall() or [])]
            
            conn.close()
            return jsonify({"ok": True, "items": items})
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 503

    @app.route("/api/farmer_account_action.php", methods=["POST"])
    def farmer_account_action():
        try:
            conn = _connect()
            ensure_farmer_mod_columns(conn)
            data = request.get_json(silent=True) or request.form or {}
            farmer_id = int(data.get("farmer_id", 0))
            action = str(data.get("action", ""))
            reason = str(data.get("reason", ""))
            days = int(data.get("days", 3))

            if farmer_id <= 0:
                return jsonify({"ok": False, "error": "Invalid farmer_id"}), 400
            if action not in ["warning", "suspend", "unsuspend"]:
                return jsonify({"ok": False, "error": "Invalid action"}), 400

            with conn.cursor() as cur:
                fk = _mod_farmer_pk_column(cur)
                cur.execute(
                    f"SELECT {fk} FROM farmers WHERE {fk} = %s LIMIT 1",
                    (farmer_id,),
                )
                if not cur.fetchone():
                    raise LookupError("Farmer not found")

            status = None
            if action == "warning":
                status = apply_warning(conn, farmer_id, reason)
            elif action == "suspend":
                status = apply_suspend(conn, farmer_id, reason, days)
            elif action == "unsuspend":
                status = apply_unsuspend(conn, farmer_id, reason)

            try:
                conn.commit()
            except Exception:
                pass

            return jsonify({"ok": True, "status": status, "account_status": status})
        except LookupError as e:
            return jsonify({"ok": False, "error": str(e)}), 404
        except Exception as exc:
            return jsonify({"ok": False, "error": str(exc)}), 503
