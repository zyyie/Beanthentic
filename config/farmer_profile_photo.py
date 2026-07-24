"""Load farmer profile photos from Beanthentic-App MySQL (path, blob, or base64 data URL)."""

from __future__ import annotations

import base64
import os
import re
import time
from pathlib import Path
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


def _is_postgresql_db(conn) -> bool:
    try:
        import beanthentic_env

        if beanthentic_env.is_postgresql():
            return True
        module = type(conn).__module__ or ""
        name = type(conn).__name__ or ""
        if "psycopg" in module or name in ("PostgreSQLWrapper", "connection"):
            return True
        inner = getattr(conn, "conn", None)
        if inner is not None:
            inner_module = type(inner).__module__ or ""
            if "psycopg" in inner_module:
                return True
        if hasattr(conn, "dialect"):
            return conn.dialect.name in ("postgresql", "postgres")
    except Exception:
        pass
    return False


def _table_columns(cur, table: str, conn=None) -> set[str]:
    is_postgres = False
    if conn:
        is_postgres = _is_postgresql_db(conn)

    if is_postgres:
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
    rows = cur.fetchall() or []
    out: set[str] = set()
    for row in rows:
        if isinstance(row, dict):
            name = row.get("COLUMN_NAME") or row.get("column_name")
        else:
            name = row[0]
        if name:
            out.add(str(name).lower())
    return out


def _pick_photo_column(cur, table: str, conn=None) -> str | None:
    if table in _PHOTO_COLUMN_CACHE:
        return _PHOTO_COLUMN_CACHE[table]
    cols = _table_columns(cur, table, conn)
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
            col = _pick_photo_column(cur, table, conn)
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


def fetch_farmer_photo_record_rest(farmer_id: int) -> dict[str, Any] | None:
    """Return {kind, value, mime?} via Supabase REST when SQL pooler is unavailable."""
    fid = int(farmer_id or 0)
    if fid < 1:
        return None

    from config.supabase_client import get_client

    client = get_client()
    farmer_rows = (
        client.table("farmers").select("profile_photo,user_id").eq("farmer_id", fid).limit(1).execute().data
        or []
    )
    candidates: list[Any] = []
    if farmer_rows:
        candidates.append(farmer_rows[0].get("profile_photo"))
        uid = farmer_rows[0].get("user_id")
        if uid:
            try:
                user_rows = (
                    client.table("users").select("profile_photo").eq("user_id", uid).limit(1).execute().data or []
                )
                if user_rows:
                    candidates.append(user_rows[0].get("profile_photo"))
            except Exception:
                pass
    try:
        pi_rows = (
            client.table("personal_information")
            .select("profile_photo")
            .eq("farmer_id", fid)
            .limit(1)
            .execute()
            .data
            or []
        )
        if pi_rows:
            candidates.append(pi_rows[0].get("profile_photo"))
    except Exception:
        pass

    for raw in candidates:
        if raw is None:
            continue
        if isinstance(raw, (bytes, bytearray)) and len(raw) > 32:
            mime = "image/jpeg"
            if raw[:8] == b"\x89PNG\r\n\x1a\n":
                mime = "image/png"
            return {"kind": "blob", "value": bytes(raw), "mime": mime}
        text = str(raw).strip()
        if not text:
            continue
        parsed = _parse_data_url(text)
        if parsed:
            body, mime = parsed
            return {"kind": "blob", "value": body, "mime": mime}
        if re.match(r"^https?://", text, re.I):
            return {"kind": "url", "value": text, "mime": None}
        return {"kind": "path", "value": text, "mime": None}
    return None


def farmer_profile_photo_api_path(farmer_id: int) -> str:
    fid = int(farmer_id or 0)
    if fid < 1:
        return ""
    return f"/api/farmer-profile-photo/{fid}?v={int(time.time()) // 3600}"


def farmer_photo_select_sql(conn) -> str:
    """Optional SELECT fragment for the first profile-photo column found."""
    try:
        with conn.cursor() as cur:
            col = _pick_photo_column(cur, "farmers", conn)
            if col:
                return f", f.{col} AS profile_photo_data"
            for table in _TABLES:
                if table == "farmers":
                    continue
                col = _pick_photo_column(cur, table, conn)
                if col:
                    alias = _alias(table)
                    return f", {alias}.{col} AS profile_photo_data"
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    return ""


def normalize_profile_photo_url(raw: str | None) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    if text.startswith("data:image/") or re.match(r"^https?://", text, re.I):
        return text
    return ""


def _is_bundled_app_asset(path: Path) -> bool:
    """APK-shipped sample files under android-app/.../assets — not live registration uploads."""
    parts = {p.lower() for p in path.parts}
    return "android-app" in parts and "assets" in parts


def resolve_farmer_upload_path(raw: str) -> Path | None:
    """
    Map DB web path to a readable file on the registration app server machine only.
    Skips bundled android-app assets (stale samples that share farmer_N.jpg names).
    """
    s = str(raw or "").strip()
    if not s or re.match(r"^https?://", s, re.I) or s.startswith("data:image/"):
        return None
    base_name = Path(s.replace("\\", "/")).name
    if not base_name or ".." in base_name:
        return None
    rel = s.lstrip("/").replace("\\", "/")
    admin_root = Path(__file__).resolve().parents[1]
    sibling_app = admin_root.parent / "Beanthentic-App"
    folders = (
        "uploads/farmers",
        "assets/uploads/farmers",
    )
    roots = [sibling_app] if sibling_app.is_dir() else []
    for root in roots:
        candidates = [root / rel.lstrip("/")]
        for folder in folders:
            candidates.append(root / folder / base_name)
        for path in candidates:
            try:
                if path.is_file() and path.stat().st_size > 32 and not _is_bundled_app_asset(path):
                    return path
            except OSError:
                continue
    return None


def _mime_from_photo_path(path: str) -> str:
    ext = Path(str(path or "")).suffix.lower()
    return {
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(ext, "image/jpeg")


def profile_photo_storage_candidates(profile_photo: str | None, farmer_id: int = 0) -> list[str]:
    """Object names to try in Supabase Storage profile-photos bucket."""
    names: list[str] = []
    raw = str(profile_photo or "").strip()
    if raw:
        if "profile-photos/" in raw:
            names.append(raw.split("profile-photos/", 1)[-1].split("?")[0].lstrip("/"))
        if "object/public/" in raw and "/" in raw:
            tail = raw.split("object/public/", 1)[-1]
            if "/" in tail:
                names.append(tail.split("/", 1)[-1].split("?")[0].lstrip("/"))
            names.append(raw.rsplit("/", 1)[-1].split("?")[0])
        rel = raw.replace("\\", "/").lstrip("/")
        if rel.startswith("uploads/farmers/"):
            names.append(rel)
            names.append(Path(rel).name)
        base = Path(raw.replace("\\", "/")).name
        if base:
            names.append(base)
            names.append(f"farmers/{base}")
    fid = int(farmer_id or 0)
    if fid > 0:
        for ext in (".jpg", ".jpeg", ".png", ".webp"):
            names.append(f"farmers/farmer_{fid}{ext}")
            names.append(f"farmer_{fid}{ext}")
    return list(dict.fromkeys(n for n in names if n))


def backfill_farmer_photo_to_storage(farmer_id: int, body: bytes, mime: str) -> None:
    """Copy a legacy app-server photo into Supabase Storage and update farmers.profile_photo."""
    fid = int(farmer_id or 0)
    if fid < 1 or not body or len(body) < 32:
        return
    try:
        import beanthentic_env

        ext = ".jpg"
        if "png" in (mime or ""):
            ext = ".png"
        elif "webp" in (mime or ""):
            ext = ".webp"
        name = f"farmers/farmer_{fid}{ext}"
        public_url = beanthentic_env.upload_to_supabase_storage(body, name, mime or "image/jpeg")
        if not public_url:
            return
        from config.supabase_client import get_client

        get_client().table("farmers").update({"profile_photo": public_url}).eq("farmer_id", fid).execute()
    except Exception:
        return


def fetch_photo_bytes_from_app_server(rel_path: str) -> tuple[bytes, str] | None:
    """Pull a farmer upload from Beanthentic-App (:8080) when it is not in Supabase Storage."""
    from config.app_connection import iter_legacy_asset_bases

    rel = str(rel_path or "").strip().replace("\\", "/")
    if not rel:
        return None
    if not rel.startswith("/"):
        rel = f"/{rel.lstrip('/')}"
    for base in iter_legacy_asset_bases():
        url = f"{base.rstrip('/')}{rel}"
        try:
            import urllib.request

            req = urllib.request.Request(url, headers={"User-Agent": "Beanthentic-Admin/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = resp.read()
            if body and len(body) > 32:
                ctype = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
                if ctype.startswith("image/"):
                    return body, ctype
        except Exception:
            continue
    return None


def photo_record_to_bytes(
    rec: dict[str, Any] | None, farmer_id: int = 0
) -> tuple[bytes, str] | None:
    """Convert fetch_farmer_photo_record() output to raw image bytes."""
    if not rec:
        return None
    kind = rec.get("kind")
    if kind == "blob":
        body = rec.get("value")
        if isinstance(body, (bytes, bytearray)) and len(body) > 32:
            return bytes(body), str(rec.get("mime") or "image/jpeg")
        return None
    if kind == "url":
        url = str(rec.get("value") or "").strip()
        if not url:
            return None
        if url.startswith("data:image/"):
            parsed = _parse_data_url(url)
            return parsed
        try:
            import urllib.request

            req = urllib.request.Request(url, headers={"User-Agent": "Beanthentic-Admin/1.0"})
            with urllib.request.urlopen(req, timeout=25) as resp:
                body = resp.read()
            if body and len(body) > 32:
                ctype = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
                if ctype.startswith("image/"):
                    return body, ctype
        except Exception:
            return None
        return None
    if kind == "path":
        raw = str(rec.get("value") or "").strip()
        local = resolve_farmer_upload_path(raw)
        if local and local.is_file():
            try:
                data = local.read_bytes()
                if data and len(data) > 32:
                    return data, _mime_from_photo_path(str(local))
            except OSError:
                pass
        try:
            import beanthentic_env

            for name in profile_photo_storage_candidates(raw, int(farmer_id or 0)):
                stored = beanthentic_env.download_from_supabase_storage(name)
                if stored:
                    return stored
        except Exception:
            pass
        fetched = fetch_photo_bytes_from_app_server(raw)
        if fetched:
            backfill_farmer_photo_to_storage(int(farmer_id or 0), fetched[0], fetched[1])
            return fetched
    return None


def supabase_public_photo_url(path_or_name: str, farmer_id: int = 0) -> str:
    """Public storage URL when profile-photos bucket is used."""
    import beanthentic_env

    base = beanthentic_env.supabase_url().rstrip("/")
    if not base:
        return ""
    bucket = os.getenv("BEANTHENTIC_SUPABASE_STORAGE_BUCKET", "profile-photos").strip() or "profile-photos"
    raw = str(path_or_name or "").strip()
    name = ""
    if raw:
        if "profile-photos/" in raw:
            name = raw.split("profile-photos/", 1)[-1].split("?")[0].lstrip("/")
        elif raw.startswith("farmers/"):
            name = raw.lstrip("/")
        else:
            base_name = Path(raw.replace("\\", "/")).name
            if base_name:
                name = f"farmers/{base_name}" if base_name.startswith("farmer_") else base_name
    if not name and farmer_id > 0:
        name = f"farmers/farmer_{farmer_id}.jpg"
    if not name:
        return ""
    return f"{base}/storage/v1/object/public/{bucket}/{name}"


def resolve_farmer_profile_photo_display_url(
    profile_photo: str | None,
    farmer_id: int,
    *,
    api_path_fn=None,
) -> str:
    """URL for <img src> in admin/client (https, data URL, or admin API proxy)."""
    inline = normalize_profile_photo_url(profile_photo)
    if inline:
        return inline
    fid = int(farmer_id or 0)
    fn = api_path_fn or farmer_profile_photo_api_path
    raw = str(profile_photo or "").strip()
    if not raw:
        return fn(fid) if fid > 0 else ""
    if re.match(r"^https?://", raw, re.I):
        return raw
    if raw.startswith("/uploads/") or raw.startswith("uploads/"):
        return fn(fid) if fid > 0 else ""
    if "supabase.co/storage/" in raw:
        return fn(fid) if fid > 0 else raw
    storage_url = supabase_public_photo_url(raw, fid)
    return storage_url or (fn(fid) if fid > 0 else "")
