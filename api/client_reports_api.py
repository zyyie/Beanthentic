"""
Client misconduct reports — MySQL beanthentic_app (Client Web submit → Admin Client Report).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from flask import jsonify, make_response, request
from pymysql.cursors import DictCursor

from config.app_connection import (
    app_db_params,
    app_server_base,
    clamp_limit,
    friendly_load_failure,
    load_error_payload,
    prefer_app_http_bridge,
)
from config.app_data_load import load_with_app_bridge
from config.app_http_bridge import app_http_get_json, app_http_patch_json
from config.mysql_app_bridge import connect_app_db
import beanthentic_env
from config.utils import is_authenticated

ALLOWED_STATUSES = {
    "under review",
    "blocked",
    "resolved",
    "dismissed",
    "open",
    "under_review",
    "closed",
}

STATUSES_REQUIRING_RESOLUTION_NOTE = frozenset({"closed", "resolved", "dismissed"})


def _read_connection_settings() -> dict:
    try:
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
        conn = raw.get("connection")
        return conn if isinstance(conn, dict) else {}
    except Exception:
        return {}


def _app_db_params() -> dict | None:
    cfg = _read_connection_settings()
    host = os.getenv("BEANTHENTIC_APP_DB_HOST", "").strip() or str(cfg.get("app_db_host") or "").strip()
    if not host:
        return None
    return {
        "host": host,
        "port": int(os.getenv("BEANTHENTIC_APP_DB_PORT", str(cfg.get("app_db_port") or "3306"))),
        "user": os.getenv("BEANTHENTIC_APP_DB_USER", str(cfg.get("app_db_user") or "root")),
        "password": os.getenv("BEANTHENTIC_APP_DB_PASS", str(cfg.get("app_db_pass") or "")),
        "database": os.getenv("BEANTHENTIC_APP_DB_NAME", str(cfg.get("app_db_name") or "beanthentic_app")),
        "charset": "utf8mb4",
        "cursorclass": DictCursor,
        "autocommit": True,
    }


def _app_server_base() -> str:
    base = os.getenv("BEANTHENTIC_APP_SERVER_BASE", "").strip()
    if base:
        return base.rstrip("/")
    cfg = _read_connection_settings()
    return str(cfg.get("app_server_base") or "").strip().rstrip("/")


def _normalize_status(status: str) -> str:
    s = (status or "under review").strip().lower().replace("_", " ")
    if s == "open":
        return "under review"
    if s in {"close", "closed", "done"}:
        return "closed"
    return s


def _extract_transaction_id(r: dict) -> int | None:
    for key in ("customer_transaction_id", "transaction_id", "related_transaction_id"):
        raw = r.get(key)
        if raw is None or raw == "":
            continue
        try:
            tid = int(raw)
            if tid > 0:
                return tid
        except (TypeError, ValueError):
            continue
    chat = r.get("chat_json")
    if isinstance(chat, dict):
        return _extract_transaction_id(chat)
    if isinstance(chat, str) and chat.strip():
        try:
            parsed = json.loads(chat)
            if isinstance(parsed, dict):
                return _extract_transaction_id(parsed)
        except Exception:
            pass
    return None


def _row_to_item(r: dict) -> dict:
    rid = int(r.get("report_id") or r.get("id") or 0)
    at = r.get("created_at")
    farmer_id = int(r["farmer_id"]) if r.get("farmer_id") else None
    farmer_no = r.get("farmer_no")
    if farmer_no is None and farmer_id:
        farmer_no = farmer_id
    return {
        "id": rid,
        "report_id": rid,
        "created_at": at.isoformat() if hasattr(at, "isoformat") else str(at or ""),
        "reporter_name": str(r.get("reporter_name") or "").strip(),
        "reporter_contact": str(r.get("reporter_contact") or "").strip(),
        "reason_category": str(r.get("reason_category") or "").strip(),
        "reason_detail": str(r.get("reason_detail") or "").strip(),
        "allegation": str(r.get("allegation") or "").strip(),
        "farmer_id": farmer_id,
        "farmer_no": farmer_no,
        "farmer_name": str(r.get("farmer_name") or "").strip() or "—",
        "status": _normalize_status(str(r.get("status") or "")),
        "resolution_note": str(r.get("resolution_note") or "").strip(),
        "customer_transaction_id": _extract_transaction_id(r),
    }


def _ensure_report_extra_columns(conn) -> None:
    """Add resolution_note / customer_transaction_id when missing."""
    is_pg = beanthentic_env.is_postgresql()
    alters = []
    if is_pg:
        alters = [
            "ALTER TABLE client_misconduct_report ADD COLUMN IF NOT EXISTS resolution_note TEXT",
            "ALTER TABLE client_misconduct_report ADD COLUMN IF NOT EXISTS customer_transaction_id BIGINT",
        ]
    else:
        # MySQL lacks IF NOT EXISTS for columns — ignore duplicate errors.
        alters = [
            "ALTER TABLE client_misconduct_report ADD COLUMN resolution_note TEXT NULL",
            "ALTER TABLE client_misconduct_report ADD COLUMN customer_transaction_id BIGINT UNSIGNED NULL",
        ]
    with conn.cursor() as cur:
        for sql in alters:
            try:
                cur.execute(sql)
            except Exception:
                pass


def _ensure_table(conn) -> None:
    if beanthentic_env.is_postgresql():
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS client_misconduct_report (
                  report_id BIGSERIAL PRIMARY KEY,
                  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  reporter_name VARCHAR(255) NOT NULL,
                  reporter_contact VARCHAR(255) NOT NULL DEFAULT '',
                  reason_category VARCHAR(255) NOT NULL,
                  reason_detail VARCHAR(255) NOT NULL DEFAULT '',
                  allegation TEXT NOT NULL,
                  chat_json TEXT NULL,
                  farmer_id BIGINT NULL,
                  farmer_no VARCHAR(50) NULL,
                  farmer_name VARCHAR(255) NOT NULL DEFAULT '',
                  status VARCHAR(40) NOT NULL DEFAULT 'under review'
                )
                """
            )
            # Create indexes if they don't exist
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_cmr_status ON client_misconduct_report (status)
            """)
            cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_cmr_created ON client_misconduct_report (created_at)
            """)
        _ensure_report_extra_columns(conn)
    else:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS client_misconduct_report (
                  report_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  reporter_name VARCHAR(255) NOT NULL,
                  reporter_contact VARCHAR(255) NOT NULL DEFAULT '',
                  reason_category VARCHAR(255) NOT NULL,
                  reason_detail VARCHAR(255) NOT NULL DEFAULT '',
                  allegation TEXT NOT NULL,
                  chat_json TEXT NULL,
                  farmer_id BIGINT UNSIGNED NULL,
                  farmer_no VARCHAR(50) NULL,
                  farmer_name VARCHAR(255) NOT NULL DEFAULT '',
                  status VARCHAR(40) NOT NULL DEFAULT 'under review',
                  INDEX idx_cmr_status (status),
                  INDEX idx_cmr_created (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """
            )
        _ensure_report_extra_columns(conn)


def _load_from_mysql(limit: int, status: str, q: str) -> list[dict]:
    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            raise RuntimeError("app_db_host not set in settings.json")
        conn = connect_app_db(params)
        
    try:
        _ensure_table(conn)
        sql = "SELECT * FROM client_misconduct_report WHERE 1=1"
        args: list = []
        if status:
            sql += " AND LOWER(REPLACE(status, '_', ' ')) = %s"
            args.append(_normalize_status(status))
        if q:
            like = f"%{q}%"
            sql += (
                " AND (reporter_name LIKE %s OR reporter_contact LIKE %s OR farmer_name LIKE %s"
                " OR reason_category LIKE %s OR reason_detail LIKE %s OR allegation LIKE %s)"
            )
            args.extend([like] * 6)
        sql += " ORDER BY created_at DESC, report_id DESC LIMIT %s"
        args.append(int(limit))
        with conn.cursor() as cur:
            cur.execute(sql, tuple(args))
            rows = cur.fetchall() or []
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def _load_from_app_http(limit: int, status: str, q: str) -> list[dict]:
    query: dict = {"limit": int(limit)}
    if status:
        query["status"] = status
    if q:
        query["q"] = q
    data = app_http_get_json("/api/admin_client_reports.php", query=query, timeout=15)
    if not isinstance(data, dict) or data.get("ok") is not True:
        err = (data or {}).get("error") if isinstance(data, dict) else None
        raise RuntimeError(err or "Bad response from app server")
    items = data.get("items")
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for row in items:
        if isinstance(row, dict):
            out.append(_row_to_item(row))
    return out


def load_admin_client_reports(limit: int = 500, status: str = "", q: str = "") -> tuple[list[dict], str]:
    """MySQL or HTTP bridge — reads client_misconduct_report only."""
    limit = clamp_limit(limit or 500, maximum=1000)

    if beanthentic_env.uses_supabase_anon():
        from config.supabase_client_reports_load import fetch_client_reports_via_rest

        rows = fetch_client_reports_via_rest(limit=limit, status=status, q=q)
        return [_row_to_item(r) for r in rows], "supabase_rest"

    return load_with_app_bridge(
        module_label="client reports",
        mysql_loader=lambda: _load_from_mysql(limit, status, q),
        http_loader=lambda: _load_from_app_http(limit, status, q),
    )


def _update_report_via_http(report_id: int, status: str, resolution_note: str = "") -> dict:
    payload = {"report_id": report_id, "status": status}
    if resolution_note:
        payload["resolution_note"] = resolution_note
    data = app_http_patch_json(
        "/api/admin_client_reports.php",
        payload,
    )
    if data.get("ok") is False:
        raise RuntimeError(str(data.get("detail") or data.get("error") or "HTTP update failed"))
    item = data.get("item")
    if isinstance(item, dict):
        return _row_to_item(item)
    raise LookupError("Report not found")


def update_report_status(report_id: int, status: str, resolution_note: str = "") -> dict:
    if report_id < 1:
        raise ValueError("Invalid report id")
    status = _normalize_status(status)
    if status not in ALLOWED_STATUSES:
        raise ValueError("Invalid status")
    note = str(resolution_note or "").strip()
    if status in STATUSES_REQUIRING_RESOLUTION_NOTE and not note:
        raise ValueError("A resolution note is required before closing this report.")

    if beanthentic_env.uses_supabase_anon():
        from config.supabase_client_reports_load import update_client_report_status_via_rest

        row = update_client_report_status_via_rest(report_id, status, resolution_note=note)
        return _row_to_item(row)

    def _mysql_update() -> dict:
        if beanthentic_env.is_postgresql():
            conn = connect_app_db({})
        else:
            params = app_db_params()
            if not params:
                raise RuntimeError("app_db_host not set in settings.json")
            conn = connect_app_db(params)
            
        try:
            _ensure_table(conn)
            with conn.cursor() as cur:
                try:
                    cur.execute(
                        "UPDATE client_misconduct_report SET status = %s, resolution_note = %s WHERE report_id = %s",
                        (status, note or None, int(report_id)),
                    )
                except Exception:
                    cur.execute(
                        "UPDATE client_misconduct_report SET status = %s WHERE report_id = %s",
                        (status, int(report_id)),
                    )
                if cur.rowcount <= 0:
                    raise LookupError("Report not found")
                cur.execute(
                    "SELECT * FROM client_misconduct_report WHERE report_id = %s LIMIT 1",
                    (int(report_id),),
                )
                row = cur.fetchone()
            if not row:
                raise LookupError("Report not found")
            item = _row_to_item(row)
            if note and not item.get("resolution_note"):
                item["resolution_note"] = note
            return item
        finally:
            conn.close()

    # If using Supabase/PostgreSQL, just use the direct update
    if beanthentic_env.is_postgresql():
        return _mysql_update()

    if prefer_app_http_bridge() and app_server_base():
        try:
            return _update_report_via_http(report_id, status, note)
        except LookupError:
            raise
        except Exception:
            pass
        try:
            return _mysql_update()
        except LookupError:
            raise
        except Exception as mysql_err:
            raise RuntimeError(
                friendly_load_failure(module_label="client report update", mysql_error=mysql_err)
            ) from mysql_err

    if app_db_params():
        try:
            return _mysql_update()
        except LookupError:
            raise
        except Exception as mysql_err:
            if app_server_base():
                try:
                    return _update_report_via_http(report_id, status, note)
                except LookupError:
                    raise
                except Exception as http_err:
                    raise RuntimeError(
                        friendly_load_failure(
                            module_label="client report update",
                            mysql_error=mysql_err,
                            http_error=http_err,
                        )
                    ) from http_err
            raise RuntimeError(
                friendly_load_failure(module_label="client report update", mysql_error=mysql_err)
            ) from mysql_err

    if app_server_base():
        return _update_report_via_http(report_id, status, note)
    raise RuntimeError("app_db_host or app_server_base required in settings.json")


def register_client_reports_routes(app) -> None:
    @app.route("/api/misconduct-reports", methods=["GET"])
    @app.route("/api/client-reports-list", methods=["GET"])
    def api_client_reports_list():
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized", "items": []}), 401
        limit = clamp_limit(request.args.get("limit", type=int) or 500, maximum=1000)
        status = str(request.args.get("status") or "").strip()[:40]
        q = str(request.args.get("q") or "").strip()[:200]
        try:
            items, source = load_admin_client_reports(limit, status, q)
            return jsonify({"ok": True, "items": items, "count": len(items), "source": source})
        except Exception as e:
            payload = load_error_payload("CLIENT_REPORTS_LOAD_FAILED", str(e))
            return jsonify(payload), 503

    @app.route("/api/misconduct-reports/<int:report_id>", methods=["PATCH"])
    def api_client_report_patch(report_id: int):
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        payload = request.get_json(silent=True) or {}
        status = str(payload.get("status") or "").strip()
        note = str(payload.get("resolution_note") or payload.get("note") or "").strip()
        if not status:
            return jsonify({"error": "status is required"}), 400
        try:
            item = update_report_status(report_id, status, resolution_note=note)
            return jsonify({"success": True, "item": item})
        except LookupError:
            return jsonify({"error": "Not found"}), 404
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/app/misconduct-report-status", methods=["GET", "OPTIONS"])
    def api_app_misconduct_report_status():
        """Client Web status lookup by report_id and/or reporter_email / reporter_phone."""
        if request.method == "OPTIONS":
            return make_response("", 204)

        report_id_raw = str(request.args.get("report_id") or "").strip()
        reporter_email = str(request.args.get("reporter_email") or "").strip().lower()
        reporter_phone = str(
            request.args.get("reporter_phone") or request.args.get("reporter_contact") or ""
        ).strip()

        report_id = 0
        if report_id_raw:
            try:
                report_id = int(report_id_raw)
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": "Invalid report_id"}), 400

        if report_id < 1 and not reporter_email and not reporter_phone:
            return jsonify(
                {
                    "ok": False,
                    "error": "Provide report_id and/or reporter_email / reporter_phone",
                }
            ), 400

        try:
            items, source = load_admin_client_reports(limit=500, status="", q="")
        except Exception as e:
            payload = load_error_payload("CLIENT_REPORTS_LOAD_FAILED", str(e))
            return jsonify(payload), 503

        def _phone_tail(val: str) -> str:
            import re

            d = re.sub(r"\D", "", str(val or ""))
            if d.startswith("0"):
                d = d[1:]
            if d.startswith("63"):
                d = d[2:]
            return d[-10:] if len(d) >= 10 else d

        want_phone = _phone_tail(reporter_phone) if reporter_phone else ""
        matches = []
        for item in items:
            if report_id > 0 and int(item.get("report_id") or item.get("id") or 0) != report_id:
                continue
            contact = str(item.get("reporter_contact") or "").strip()
            contact_l = contact.lower()
            if reporter_email and reporter_email not in contact_l:
                continue
            if want_phone and _phone_tail(contact) != want_phone:
                continue
            matches.append(
                {
                    "report_id": item.get("report_id") or item.get("id"),
                    "status": item.get("status"),
                    "resolution_note": item.get("resolution_note") or "",
                    "created_at": item.get("created_at"),
                    "reason_category": item.get("reason_category") or "",
                }
            )

        if report_id > 0 and not matches:
            return jsonify({"ok": False, "error": "Report not found", "items": []}), 404

        primary = matches[0] if matches else None
        return jsonify(
            {
                "ok": True,
                "source": source,
                "item": primary,
                "items": matches,
                "status": (primary or {}).get("status"),
                "resolution_note": (primary or {}).get("resolution_note") or "",
            }
        )
