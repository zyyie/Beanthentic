"""
Beanthentic-App admin HTTP bridges (run on the device that hosts port 8080).

Copy this file next to app.py on the app server, then in app.py add:

    try:
        from admin_bridges import register_admin_bridges
        register_admin_bridges(app)
    except ImportError:
        pass

Requires: pip install pymysql
"""

from __future__ import annotations

import base64
import os
import re
from typing import Any

from flask import Response, jsonify, request

try:
    import pymysql
    from pymysql.cursors import DictCursor
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
    return {
        "host": os.getenv("BEANTHENTIC_DB_HOST", "127.0.0.1"),
        "port": int(os.getenv("BEANTHENTIC_DB_PORT", "3306")),
        "user": os.getenv("BEANTHENTIC_DB_USER", "root"),
        "password": os.getenv("BEANTHENTIC_DB_PASS", ""),
        "database": os.getenv("BEANTHENTIC_DB_NAME", "beanthentic_app"),
        "charset": "utf8mb4",
        "cursorclass": DictCursor,
        "connect_timeout": 8,
        "read_timeout": 12,
        "write_timeout": 12,
    }


def _connect():
    if pymysql is None:
        raise RuntimeError("pymysql is not installed on the app server")
    return pymysql.connect(**_db_params())


def _table_columns(cur, table: str) -> dict[str, str]:
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
