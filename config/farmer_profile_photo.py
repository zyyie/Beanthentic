"""Load farmer profile photos from Beanthentic-App MySQL (path, blob, or base64 data URL)."""

from __future__ import annotations

import base64
import re
import time
from typing import Any

_PHOTO_COLUMN_CACHE: dict[str, str | None] = {}
_TABLES = ("users", "personal_information", "farmers")
_CANDIDATES = (
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


def _table_columns(cur, table: str) -> set[str]:
    cur.execute(
        """
        SELECT COLUMN_NAME, DATA_TYPE
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
        """,
        (table,),
    )
    rows = cur.fetchall() or []
    out: set[str] = set()
    for row in rows:
        name = row.get("COLUMN_NAME") if isinstance(row, dict) else row[0]
        if name:
            out.add(str(name).lower())
    return out


def _pick_photo_column(cur, table: str) -> str | None:
    if table in _PHOTO_COLUMN_CACHE:
        return _PHOTO_COLUMN_CACHE[table]
    cols = _table_columns(cur, table)
    picked = None
    for candidate in _CANDIDATES:
        if candidate in cols:
            picked = candidate
            break
    _PHOTO_COLUMN_CACHE[table] = picked
    return picked


def _join_clause(table: str) -> str:
    if table == "users":
        return "LEFT JOIN users u ON u.user_id = f.user_id"
    if table == "personal_information":
        return "LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id"
    return f"LEFT JOIN {table} t ON t.farmer_id = f.farmer_id"


def _alias(table: str) -> str:
    if table == "users":
        return "u"
    if table == "personal_information":
        return "pi"
    return "t"


def _parse_data_url(text: str) -> tuple[bytes, str] | None:
    s = (text or "").strip()
    if not s.startswith("data:image/"):
        return None
    match = re.match(r"^data:(image/[^;]+);base64,(.+)$", s, re.I | re.S)
    if not match:
        return None
    try:
        return base64.b64decode(match.group(2)), match.group(1)
    except Exception:
        return None


def fetch_farmer_photo_record(conn, farmer_id: int) -> dict[str, Any] | None:
    """Return {kind, value, mime?} or None."""
    fid = int(farmer_id or 0)
    if fid < 1:
        return None

    with conn.cursor() as cur:
        for table in _TABLES:
            col = _pick_photo_column(cur, table)
            if not col:
                continue
            alias = _alias(table)
            cur.execute(
                f"""
                SELECT {alias}.{col} AS photo_value
                FROM farmers f
                {_join_clause(table)}
                WHERE f.farmer_id = %s
                LIMIT 1
                """,
                (fid,),
            )
            row = cur.fetchone()
            if not row:
                continue
            raw = row.get("photo_value") if isinstance(row, dict) else row[0]
            if raw is None:
                continue
            if isinstance(raw, (bytes, bytearray)) and len(raw) > 32:
                mime = "image/jpeg"
                if raw[:8] == b"\x89PNG\r\n\x1a\n":
                    mime = "image/png"
                elif raw[:6] in (b"GIF87a", b"GIF89a"):
                    mime = "image/gif"
                elif raw[:4] == b"RIFF" and len(raw) > 12 and raw[8:12] == b"WEBP":
                    mime = "image/webp"
                return {"kind": "blob", "value": bytes(raw), "mime": mime}
            text = str(raw).strip()
            if not text:
                continue
            parsed = _parse_data_url(text)
            if parsed:
                body, mime = parsed
                return {"kind": "blob", "value": body, "mime": mime}
            if text.startswith("/9j/") or text.startswith("iVBOR"):
                mime = "image/jpeg" if text.startswith("/9j/") else "image/png"
                try:
                    return {
                        "kind": "blob",
                        "value": base64.b64decode(text),
                        "mime": mime,
                    }
                except Exception:
                    pass
            if re.match(r"^https?://", text, re.I):
                return {"kind": "url", "value": text, "mime": None}
            return {"kind": "path", "value": text, "mime": None}
    return None


def farmer_profile_photo_api_path(farmer_id: int) -> str:
    fid = int(farmer_id or 0)
    if fid < 1:
        return ""
    return f"/api/farmer-profile-photo/{fid}?v={int(time.time()) // 3600}"
