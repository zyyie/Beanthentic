"""
GI Farmer contributions — mobile app (gi_updates) ↔ admin Farmer's Contribution inbox.
"""

from __future__ import annotations

import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import jsonify, request

from config.app_connection import (
    GI_UPLOAD_STATUSES,
    app_db_params,
    app_server_base,
    clamp_limit,
    friendly_load_failure,
    load_error_payload,
)
from config.mysql_app_bridge import connect_app_mysql
from config.utils import is_authenticated


def ensure_gi_updates_table(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS gi_updates (
          gi_update_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          farmer_id BIGINT UNSIGNED NULL,
          current_phase VARCHAR(64) NOT NULL DEFAULT 'farmer_submission',
          title VARCHAR(255) NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          preview TEXT NULL,
          category VARCHAR(64) NOT NULL DEFAULT 'general',
          sender_name VARCHAR(255) NOT NULL DEFAULT '',
          attachments_json TEXT NULL,
          upload_status VARCHAR(32) NOT NULL DEFAULT 'pending',
          is_starred TINYINT(1) NOT NULL DEFAULT 0,
          is_read_admin TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NULL,
          INDEX idx_gi_phase (current_phase),
          INDEX idx_gi_created (created_at),
          INDEX idx_gi_farmer (farmer_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """
    )


def _parse_gi_attachments(raw, base: str) -> list[dict]:
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        items = raw
    else:
        try:
            items = json.loads(raw)
        except Exception:
            return []
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        path = str(item.get("url") or item.get("path") or item.get("file_path") or "").strip()
        url = path
        if path and not path.startswith(("http://", "https://")) and base:
            url = f"{base.rstrip('/')}/{path.lstrip('/')}"
        out.append(
            {
                "name": str(item.get("name") or item.get("filename") or "file"),
                "url": url,
                "path": path,
                "mime": str(item.get("mime") or item.get("type") or ""),
            }
        )
    return out


def _gi_row_to_admin_item(row: dict, base: str) -> dict:
    gid = int(row.get("gi_update_id") or row.get("id") or 0)
    content = str(row.get("content") or "").strip()
    preview = str(row.get("preview") or "").strip()
    if not preview and content:
        preview = " ".join(content.split())[:200]
    created = row.get("created_at")
    created_iso = created.isoformat() if hasattr(created, "isoformat") else str(created or "")
    attachments_raw = row.get("attachments_json") or row.get("attachments")
    status = str(row.get("upload_status") or "pending").lower()
    return {
        "gi_update_id": gid,
        "id": gid,
        "farmer_id": int(row["farmer_id"]) if row.get("farmer_id") else None,
        "farmer_name": str(row.get("farmer_name") or row.get("sender_name") or "Farmer"),
        "farmer_email": str(row.get("email") or row.get("farmer_email") or ""),
        "title": str(row.get("title") or row.get("subject") or "GI Update"),
        "subject": str(row.get("title") or row.get("subject") or "GI Update"),
        "content": content,
        "preview": preview,
        "category": str(row.get("category") or "general"),
        "upload_status": status,
        "status": status,
        "is_starred": bool(row.get("is_starred")),
        "starred": bool(row.get("is_starred")),
        "is_read_admin": bool(row.get("is_read_admin")),
        "unread": not bool(row.get("is_read_admin")),
        "created_at": created_iso,
        "attachments": _parse_gi_attachments(attachments_raw, base),
        "current_phase": str(row.get("current_phase") or ""),
    }


def _load_from_http(limit: int) -> list[dict]:
    base = app_server_base()
    if not base:
        raise RuntimeError("app_server_base not set in settings.json")
    url = f"{base}/api/admin_gi_contributions.php?{urlencode({'limit': limit})}"
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not isinstance(data, dict) or not data.get("ok"):
        err = data.get("error") if isinstance(data, dict) else None
        raise RuntimeError(str(err or "HTTP load failed"))
    items = data.get("items")
    if not isinstance(items, list):
        return []
    return [row for row in items if isinstance(row, dict)]


def _load_from_mysql(limit: int) -> list[dict]:
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set in settings.json")
    base = app_server_base()
    conn = connect_app_mysql(params)
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            cur.execute(
                """
                SELECT g.*, u.email, u.username, u.phone_number,
                       pi.first_name, pi.last_name
                FROM gi_updates g
                LEFT JOIN farmers f ON f.farmer_id = g.farmer_id
                LEFT JOIN users u ON u.user_id = f.user_id
                LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
                WHERE g.current_phase = 'farmer_submission'
                ORDER BY g.created_at DESC, g.gi_update_id DESC
                LIMIT %s
                """,
                (limit,),
            )
            items = []
            for row in cur.fetchall() or []:
                fn = str(row.get("first_name") or "").strip()
                ln = str(row.get("last_name") or "").strip()
                farmer_name = (fn + " " + ln).strip() or str(row.get("sender_name") or "Farmer")
                items.append(_gi_row_to_admin_item({**row, "farmer_name": farmer_name}, base))
            return items
    finally:
        conn.close()


def load_admin_gi_contributions(limit: int = 500) -> tuple[list[dict], str]:
    limit = clamp_limit(limit)
    mysql_err: Exception | None = None
    http_err: Exception | None = None
    try:
        return _load_from_mysql(limit), "mysql"
    except Exception as e:
        print(f"GI Contributions MySQL error: {e}")
        mysql_err = e
    try:
        items = _load_from_http(limit)
        base = app_server_base()
        return [_gi_row_to_admin_item(row, base) for row in items], "http"
    except Exception as e:
        print(f"GI Contributions HTTP error: {e}")
        http_err = e
    raise RuntimeError(
        friendly_load_failure(
            module_label="GI contributions",
            mysql_error=mysql_err,
            http_error=http_err,
        )
    )


def _patch_mysql(gi_id: int, fields: dict) -> int:
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set")
    conn = connect_app_mysql(params)
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            sets = []
            args: list = []
            if "is_starred" in fields:
                sets.append("is_starred = %s")
                args.append(1 if fields["is_starred"] else 0)
            if "is_read_admin" in fields:
                sets.append("is_read_admin = %s")
                args.append(1 if fields["is_read_admin"] else 0)
            if "upload_status" in fields:
                sets.append("upload_status = %s")
                args.append(fields["upload_status"])
            if not sets:
                return 0
            args.append(gi_id)
            cur.execute(
                f"UPDATE gi_updates SET {', '.join(sets)} WHERE gi_update_id = %s AND current_phase = 'farmer_submission'",
                tuple(args),
            )
            return int(cur.rowcount or 0)
    finally:
        conn.close()


def register_gi_contributions_routes(app) -> None:
    @app.route("/api/gi-contributions-list", methods=["GET"])
    def api_gi_contributions_list():
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized", "items": []}), 401
        limit = clamp_limit(request.args.get("limit", type=int) or 500)
        try:
            items, source = load_admin_gi_contributions(limit)
            if not isinstance(items, list):
                items = []
            return jsonify({"ok": True, "items": items, "count": len(items), "source": source})
        except Exception as e:
            payload = load_error_payload("GI_CONTRIBUTIONS_LOAD_FAILED", str(e))
            return jsonify(payload), 503

    @app.route("/api/gi-contributions/<int:gi_id>", methods=["PATCH", "DELETE"])
    def api_gi_contribution_item(gi_id: int):
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        if gi_id < 1:
            return jsonify({"ok": False, "error": "Invalid contribution id"}), 400

        if request.method == "DELETE":
            try:
                params = app_db_params()
                if not params:
                    return jsonify({"ok": False, "error": "app_db_host not set in settings.json"}), 503
                conn = connect_app_mysql(params)
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            "DELETE FROM gi_updates WHERE gi_update_id = %s AND current_phase = 'farmer_submission'",
                            (gi_id,),
                        )
                        deleted = int(cur.rowcount or 0)
                finally:
                    conn.close()
                if deleted <= 0:
                    return jsonify({"ok": False, "error": "Contribution not found"}), 404
                return jsonify({"ok": True, "deleted": deleted})
            except Exception as e:
                return jsonify({"ok": False, "error": str(e), "message": str(e)}), 500

        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            return jsonify({"ok": False, "error": "Request body must be JSON"}), 400

        fields = {}
        if "is_starred" in body or "starred" in body:
            fields["is_starred"] = bool(body.get("is_starred") or body.get("starred"))
        if "is_read_admin" in body:
            fields["is_read_admin"] = bool(body.get("is_read_admin"))
        elif "unread" in body:
            fields["is_read_admin"] = not bool(body.get("unread"))
        if "upload_status" in body or "status" in body:
            status = str(body.get("upload_status") or body.get("status") or "").strip().lower()
            if status not in GI_UPLOAD_STATUSES:
                return jsonify(
                    {
                        "ok": False,
                        "error": "Invalid status",
                        "message": f"status must be one of: {', '.join(sorted(GI_UPLOAD_STATUSES))}",
                    }
                ), 400
            fields["upload_status"] = status

        if not fields:
            return jsonify({"ok": False, "error": "No valid fields to update"}), 400

        try:
            updated = _patch_mysql(gi_id, fields)
            if updated <= 0:
                return jsonify({"ok": False, "error": "Contribution not found"}), 404
            return jsonify({"ok": True, "updated": updated})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e), "message": str(e)}), 500
