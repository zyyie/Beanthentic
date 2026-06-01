"""
Client misconduct reports — MySQL beanthentic_app (Client Web submit → Admin Client Report).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import jsonify, request
from pymysql.cursors import DictCursor

from config.app_connection import (
    app_db_params,
    app_server_base,
    clamp_limit,
    friendly_load_failure,
    load_error_payload,
)
from config.app_http_bridge import app_http_patch_json
from config.mysql_app_bridge import connect_app_mysql
from config.utils import is_authenticated

ALLOWED_STATUSES = {"under review", "blocked", "resolved", "dismissed", "open", "under_review"}


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
    return s


def _row_to_item(r: dict) -> dict:
    rid = int(r.get("report_id") or r.get("id") or 0)
    at = r.get("created_at")
    return {
        "id": rid,
        "report_id": rid,
        "created_at": at.isoformat() if hasattr(at, "isoformat") else str(at or ""),
        "reporter_name": str(r.get("reporter_name") or "").strip(),
        "reporter_contact": str(r.get("reporter_contact") or "").strip(),
        "reason_category": str(r.get("reason_category") or "").strip(),
        "reason_detail": str(r.get("reason_detail") or "").strip(),
        "allegation": str(r.get("allegation") or "").strip(),
        "farmer_id": int(r["farmer_id"]) if r.get("farmer_id") else None,
        "farmer_no": r.get("farmer_no"),
        "farmer_name": str(r.get("farmer_name") or "").strip() or "—",
        "status": _normalize_status(str(r.get("status") or "")),
    }


def _ensure_table(conn) -> None:
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


def _load_from_mysql(limit: int, status: str, q: str) -> list[dict]:
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set in settings.json")
    conn = connect_app_mysql(params)
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
    base = app_server_base()
    if not base:
        raise RuntimeError("app_server_base not set in settings.json")
    query = {"limit": int(limit)}
    if status:
        query["status"] = status
    if q:
        query["q"] = q
    url = f"{base}/api/admin_client_reports.php?{urlencode(query)}"
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=15) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    data = json.loads(raw) if raw else {}
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
    """MySQL first, HTTP fallback — reads client_misconduct_report only."""
    limit = clamp_limit(limit or 500, maximum=1000)
    mysql_err: Exception | None = None
    http_err: Exception | None = None
    try:
        return _load_from_mysql(limit, status, q), "app_mysql"
    except Exception as e:
        mysql_err = e
    try:
        return _load_from_app_http(limit, status, q), "app_server_http"
    except Exception as e:
        http_err = e
    raise RuntimeError(
        friendly_load_failure(
            module_label="client reports",
            mysql_error=mysql_err,
            http_error=http_err,
        )
    )


def _update_report_via_http(report_id: int, status: str) -> dict:
    data = app_http_patch_json(
        "/api/admin_client_reports.php",
        {"report_id": report_id, "status": status},
    )
    if data.get("ok") is False:
        raise RuntimeError(str(data.get("detail") or data.get("error") or "HTTP update failed"))
    item = data.get("item")
    if isinstance(item, dict):
        return _row_to_item(item)
    raise LookupError("Report not found")


def update_report_status(report_id: int, status: str) -> dict:
    if report_id < 1:
        raise ValueError("Invalid report id")
    status = _normalize_status(status)
    if status not in ALLOWED_STATUSES:
        raise ValueError("Invalid status")

    mysql_err: Exception | None = None
    params = app_db_params()
    if params:
        try:
            conn = connect_app_mysql(params)
            try:
                _ensure_table(conn)
                with conn.cursor() as cur:
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
                return _row_to_item(row)
            finally:
                conn.close()
        except LookupError:
            raise
        except ValueError:
            raise
        except Exception as e:
            mysql_err = e

    if app_server_base():
        try:
            return _update_report_via_http(report_id, status)
        except LookupError:
            raise
        except Exception as http_err:
            if mysql_err:
                raise RuntimeError(
                    friendly_load_failure(
                        module_label="client report update",
                        mysql_error=mysql_err,
                        http_error=http_err,
                    )
                ) from http_err
            raise

    if mysql_err:
        raise RuntimeError(friendly_load_failure(module_label="client report update", mysql_error=mysql_err))
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
        if not status:
            return jsonify({"error": "status is required"}), 400
        try:
            item = update_report_status(report_id, status)
            return jsonify({"success": True, "item": item})
        except LookupError:
            return jsonify({"error": "Not found"}), 404
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500
