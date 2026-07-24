"""
GI Farmer contributions — farmer messages in gi_farmers_contribution; IPOPHL/admin in gi_updates.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from flask import abort, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from config.app_connection import (
    GI_UPLOAD_STATUSES,
    app_db_params,
    app_server_base,
    clamp_limit,
    friendly_load_failure,
    is_app_db_configured,
    is_loopback_host,
    iter_app_server_bases,
    load_error_payload,
    read_connection_settings,
)
from config.app_http_bridge import app_http_delete_json, app_http_get_json, app_http_patch_json, app_http_post_multipart
from config.mysql_app_bridge import connect_app_db
import beanthentic_env
from config.utils import is_authenticated

GI_CONTRIB_UPLOAD_DIR = Path(__file__).resolve().parents[1] / "uploads" / "gi_contributions"
FARMER_GI_APP_UPLOAD_DIR = (
    Path(__file__).resolve().parents[1].parent
    / "Beanthentic-App"
    / "android-app"
    / "app"
    / "src"
    / "main"
    / "assets"
    / "uploads"
    / "gi_contributions"
)
GI_ALLOWED_EXTENSIONS = frozenset(
    {".pdf", ".doc", ".docx", ".txt", ".md", ".csv", ".jpg", ".jpeg", ".png", ".gif", ".webp"}
)
GI_MAX_FILE_BYTES = 15 * 1024 * 1024
GI_MAX_FILES = 5
IPOPHL_GI_MAX_FILES = 30
IPOPHL_GI_SENDER = "IPOPHL Administrator"
# PHP only keeps every file when the multipart field is files[] (not files).
GI_MULTIPART_FILE_FIELD = "files[]"


def _can_use_app_db() -> bool:
    """True when Supabase/PostgreSQL or legacy MySQL app DB is configured."""
    if beanthentic_env.is_postgresql():
        return True
    return bool(app_db_params())


def _open_app_db():
    """Open app DB (Supabase PostgreSQL or legacy MySQL)."""
    if beanthentic_env.is_postgresql():
        return connect_app_db({})
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set in settings.json")
    return connect_app_db(params)


def _sql_bool(value: bool):
    if beanthentic_env.is_postgresql():
        return bool(value)
    return 1 if value else 0


def probe_app_mysql(timeout: float = 4.0) -> tuple[bool, str]:
    """Can admin PC reach XAMPP MySQL (settings.json app_db_host) or PostgreSQL/Supabase?"""
    # Check if we're using PostgreSQL first
    if beanthentic_env.is_postgresql():
        try:
            conn = connect_app_db({})
            with conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok")
                cur.fetchone()
            conn.close()
            return True, ""
        except Exception as e:
            from config.app_connection import friendly_mysql_error
            return False, friendly_mysql_error(e, host="Supabase/PostgreSQL")

    params = app_db_params()
    if not params:
        return False, "app_db_host is not set in settings.json"
    conn = None
    try:
        conn = connect_app_db({**params, "connect_timeout": int(max(2, min(timeout, 12)))})
        with conn.cursor() as cur:
            cur.execute("SELECT 1 AS ok")
            cur.fetchone()
        return True, ""
    except Exception as e:
        from config.app_connection import friendly_mysql_error
        return False, friendly_mysql_error(e, host=str(params.get("host") or ""))
    finally:
        if conn:
            conn.close()


def probe_gi_app_server(timeout: float = 4.0) -> tuple[bool, str, str]:
    """
    Quick check that Beanthentic-App (:8080) answers before a long Complete Registration.
    Returns (reachable, base_used, error_message).
    """
    from urllib.error import HTTPError
    from urllib.request import Request, urlopen

    bases = _gi_app_server_bases()
    if not bases:
        return False, "", "app_server_base is not set in settings.json"
    last_err = ""
    for base in bases:
        url = f"{base.rstrip('/')}/api/admin_farmer_data.php"
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                last_err = f"Non-JSON response from {url}"
                continue
            if isinstance(data, dict) and data.get("ok") is True:
                return True, base, ""
            last_err = str(data.get("error") or data.get("detail") or f"Unexpected response from {url}")
        except HTTPError as e:
            last_err = f"HTTP {e.code} at {url}"
        except Exception as e:
            last_err = str(e)
    cfg_base = (app_server_base() or bases[0]).strip()
    return False, "", (
        f"Cannot reach the app server at {cfg_base} (port 8080). "
        f"On that PC: start XAMPP MySQL, run python app.py. "
        f"Last error: {last_err}"
    )


def check_xampp_for_publish() -> dict:
    """JSON for browser preflight before Complete Registration."""
    if beanthentic_env.is_postgresql() or is_app_db_configured():
        mysql_ok, mysql_err = probe_app_mysql(timeout=4.0)
        return {
            "ok": mysql_ok,
            "prefer_http": False,
            "mysql_reachable": mysql_ok,
            "mysql_error": None if mysql_ok else mysql_err,
            "app_server_base": "",
            "reachable_base": "",
            "xampp_reachable": False,
            "source": "supabase" if beanthentic_env.is_postgresql() else "app_db",
            "error": None if mysql_ok else mysql_err,
            "hint": (
                "Check BEANTHENTIC_DB_HOST / BEANTHENTIC_DB_URL in .env for Supabase pooler access."
                if beanthentic_env.is_postgresql()
                else "Set app_db_host in settings.json or Supabase keys in connection settings."
            ),
        }

    prefer_http = _prefer_http_for_gi_send()
    bases = _gi_app_server_bases()
    mysql_ok, mysql_err = probe_app_mysql(timeout=4.0)
    reachable, used, http_err = probe_gi_app_server(timeout=4.0)
    can_publish = mysql_ok or reachable
    return {
        "ok": can_publish,
        "prefer_http": prefer_http,
        "mysql_reachable": mysql_ok,
        "mysql_error": None if mysql_ok else mysql_err,
        "app_server_base": bases[0] if bases else "",
        "reachable_base": used or "",
        "xampp_reachable": reachable,
        "error": None if can_publish else (http_err or mysql_err),
        "hint": (
            "Set app_db_host + app_server_base to the XAMPP PC LAN IP. "
            "Start MySQL and python app.py on that device. "
            "On the phone, Server URL must match app_server_base (port 8080)."
        ),
    }


def _gi_app_server_bases() -> list[str]:
    """
    Beanthentic-App (:8080) URLs for GI / IPOPHL publish.
    Uses connection.app_server_base first — never the SMS gateway phone host.
    """
    ordered: list[str] = []
    seen: set[str] = set()
    sms_gw_base = ""

    def add(url: str | None) -> None:
        base = (url or "").strip().rstrip("/")
        if base and base not in seen:
            seen.add(base)
            ordered.append(base)

    try:
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        root = json.loads(settings_path.read_text(encoding="utf-8"))
        if not isinstance(root, dict):
            root = {}
    except Exception:
        root = {}
    from config.app_connection import app_server_base, optional_app_server_base

    conn = root.get("connection") if isinstance(root.get("connection"), dict) else {}
    app_base = str(
        conn.get("app_server_base") or optional_app_server_base() or app_server_base() or ""
    ).strip().rstrip("/")
    sms = root.get("sms") if isinstance(root.get("sms"), dict) else {}
    gw = sms.get("sms_gateway") if isinstance(sms.get("sms_gateway"), dict) else {}
    sms_gw_base = str(gw.get("local_base_url") or "").strip().rstrip("/")

    add(app_base)
    for base in iter_app_server_bases():
        if sms_gw_base and base == sms_gw_base:
            continue
        add(base)
    return ordered


def _gi_http_bases() -> list[str]:
    """Backward-compatible alias — always the app server, not SMS gateway."""
    return _gi_app_server_bases()


def _prefer_http_for_gi_send() -> bool:
    if beanthentic_env.is_postgresql():
        return False
    params = app_db_params()
    if not params:
        return bool(_gi_app_server_bases())
    host = str(params.get("host") or "").strip()
    if is_loopback_host(host):
        return False
    return bool(_gi_app_server_bases())


def _upload_files_for_http(uploads) -> list[tuple[str, str, bytes, str | None]]:
    out: list[tuple[str, str, bytes, str | None]] = []
    for upload in uploads[:GI_MAX_FILES]:
        if not upload or not getattr(upload, "filename", None):
            continue
        original = secure_filename(upload.filename)
        if not original:
            continue
        ext = Path(original).suffix.lower()
        if ext not in GI_ALLOWED_EXTENSIONS:
            continue
        upload.seek(0, 2)
        size = upload.tell()
        upload.seek(0)
        if size <= 0 or size > GI_MAX_FILE_BYTES:
            continue
        out.append(
            (
                GI_MULTIPART_FILE_FIELD,
                original,
                upload.read(),
                upload.mimetype or mimetypes.guess_type(original)[0],
            )
        )
    return out


def _display_filename(original: str, path: Path) -> str:
    """Human-readable name for UI (may repeat); not used as multipart filename."""
    raw = str(original or "").strip()
    safe = secure_filename(raw)
    if safe and safe not in ("uploaded.docx", "uploaded.pdf", "uploaded.doc", "file"):
        return safe
    return path.name


def _normalize_gi_attachment(att: dict) -> dict:
    """Ensure attachment JSON paths work with mobile preview + gi_attachment.php."""
    out = dict(att)
    path = str(out.get("path") or "").strip()
    if path.startswith("http://") or path.startswith("https://"):
        try:
            from urllib.parse import urlparse

            path = urlparse(path).path or path
        except Exception:
            pass
    if path and not path.startswith("/"):
        if "uploads/gi_contributions/" in path:
            path = "/" + path.lstrip("/")
        else:
            path = f"/uploads/gi_contributions/{path.lstrip('/')}"
    if path:
        out["path"] = path
    name = str(out.get("name") or out.get("filename") or "").strip()
    if not name and path:
        name = os.path.basename(path)
    if name:
        out["name"] = name
        out["filename"] = name
    url = str(out.get("url") or "").strip()
    if path and path.startswith("/") and not url.startswith("http"):
        base = _gi_attachment_base_url(prefer_app_server=True)
        if base:
            out["url"] = f"{base.rstrip('/')}{path}"
    return out


def _multipart_upload_filename(original: str, path: Path, used: set[str]) -> str:
    """Stable upload name on the app server (matches display name when possible)."""
    display = _display_filename(original, path)
    upload = secure_filename(display) or secure_filename(path.name) or "document"
    ext = path.suffix.lower()
    if ext and not upload.lower().endswith(ext):
        upload = f"{upload}{ext}"
    candidate = upload
    n = 1
    while candidate.lower() in used:
        stem, suffix = os.path.splitext(upload)
        candidate = f"{stem}_{n}{suffix}"
        n += 1
    used.add(candidate.lower())
    return candidate


def _multipart_files_from_disk(disk_files: list[tuple[str, Path]]) -> list[tuple[str, str, bytes, str | None]]:
    """Build HTTP multipart file tuples from files on disk (e.g. IPOPHL uploads on admin web.py)."""
    out: list[tuple[str, str, bytes, str | None]] = []
    used_names: set[str] = set()
    for original, path in disk_files[:IPOPHL_GI_MAX_FILES]:
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext not in GI_ALLOWED_EXTENSIONS:
            continue
        size = path.stat().st_size
        if size <= 0 or size > GI_MAX_FILE_BYTES:
            continue
        upload_name = _multipart_upload_filename(original, path, used_names)
        mime = mimetypes.guess_type(upload_name)[0] or mimetypes.guess_type(path.name)[0]
        out.append((GI_MULTIPART_FILE_FIELD, upload_name, path.read_bytes(), mime))
    return out


def _load_ipophl_disk_files(file_uuids: list[str]) -> list[tuple[str, Path]]:
    from config.ipophl_store import get_document, resolve_file_path

    out: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for raw in file_uuids:
        file_uuid = str(raw or "").strip()
        if not file_uuid or file_uuid in seen:
            continue
        seen.add(file_uuid)
        record = get_document(file_uuid)
        hint = str(record.get("original_filename") or "") if record else None
        path = resolve_file_path(file_uuid, filename_hint=hint or None)
        if not path or not path.is_file():
            continue
        name = str((record or {}).get("original_filename") or path.name)
        out.append((name, path))
        if len(out) >= IPOPHL_GI_MAX_FILES:
            break
    return out


def _gi_attachment_base_url(*, prefer_app_server: bool = False) -> str:
    """Base URL embedded in attachment JSON for the mobile app."""
    from config.app_connection import app_server_base, optional_app_server_base

    try:
        import beanthentic_env

        admin_base = beanthentic_env.admin_public_base()
    except Exception:
        admin_base = ""
    if not admin_base:
        admin_base = _public_base_url().strip().rstrip("/")
    app_base = (optional_app_server_base() or app_server_base() or "").strip().rstrip("/")
    if prefer_app_server and app_base:
        return app_base
    if admin_base:
        return admin_base
    if app_base:
        return app_base
    return admin_base


def _mirror_farmer_gi_file_if_needed(filename: str) -> Path | None:
    """Ensure a farmer GI upload exists under admin uploads/ (local copy or HTTP fetch)."""
    return _ensure_gi_file_on_disk(filename)


def _gi_local_upload_dirs() -> list[Path]:
    admin_root = Path(__file__).resolve().parents[1]
    sibling_app = admin_root.parent / "Beanthentic-App"
    candidates = [
        GI_CONTRIB_UPLOAD_DIR,
        FARMER_GI_APP_UPLOAD_DIR,
        admin_root / "deploy" / "app_server" / "uploads" / "gi_contributions",
        sibling_app / "uploads" / "gi_contributions",
        sibling_app / "deploy" / "app_server" / "uploads" / "gi_contributions",
    ]
    return candidates


def _gi_db_source_urls_for_filename(filename: str) -> list[str]:
    """Historical attachment URLs stored in gi_farmers_contribution (may use old LAN IPs)."""
    safe = os.path.basename(str(filename or "").strip())
    if not safe:
        return []
    urls: list[str] = []
    try:
        if beanthentic_env.uses_supabase_anon():
            from config.supabase_client import get_client

            client = get_client()
            rows = (
                client.table("gi_farmers_contribution")
                .select("attachments_json")
                .limit(500)
                .execute()
                .data
                or []
            )
            for row in rows:
                for item in _parse_gi_attachments_raw(row.get("attachments_json")):
                    name = os.path.basename(
                        str(item.get("filename") or item.get("name") or item.get("path") or "")
                    )
                    if name.lower() != safe.lower():
                        continue
                    url = str(item.get("url") or "").strip()
                    if url.startswith(("http://", "https://")):
                        urls.append(url)
        elif _can_use_app_db():
            conn = _open_app_db()
            try:
                with conn.cursor() as cur:
                    ensure_gi_farmers_contribution_table(cur)
                    cur.execute(
                        "SELECT attachments_json FROM gi_farmers_contribution WHERE attachments_json IS NOT NULL LIMIT 500"
                    )
                    for row in cur.fetchall() or []:
                        raw = row.get("attachments_json") if isinstance(row, dict) else row[0]
                        for item in _parse_gi_attachments_raw(raw):
                            name = os.path.basename(
                                str(item.get("filename") or item.get("name") or item.get("path") or "")
                            )
                            if name.lower() != safe.lower():
                                continue
                            url = str(item.get("url") or "").strip()
                            if url.startswith(("http://", "https://")):
                                urls.append(url)
            finally:
                conn.close()
    except Exception:
        pass
    return list(dict.fromkeys(urls))


def _gi_remote_fetch_urls(filename: str) -> list[str]:
    safe = os.path.basename(str(filename or "").strip())
    if not safe:
        return []
    rel = f"/uploads/gi_contributions/{safe}"
    urls: list[str] = []
    seen: set[str] = set()

    def add(url: str | None) -> None:
        u = str(url or "").strip()
        if u and u not in seen:
            seen.add(u)
            urls.append(u)

    from config.app_connection import iter_legacy_asset_bases

    for base in iter_legacy_asset_bases():
        add(f"{base.rstrip('/')}{rel}")
        add(f"{base.rstrip('/')}/api/gi_attachment.php?path={rel}")
    for url in _gi_db_source_urls_for_filename(safe):
        add(url)
    return urls


def _fetch_http_bytes(url: str, *, timeout: float = 8.0) -> bytes | None:
    try:
        import urllib.error
        import urllib.request

        req = urllib.request.Request(url, headers={"User-Agent": "Beanthentic-Admin/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
        if body and len(body) > 16:
            return body
    except Exception:
        return None
    return None


def _ensure_gi_file_on_disk(filename: str) -> Path | None:
    safe = secure_filename(os.path.basename(str(filename or "").strip())) or os.path.basename(
        str(filename or "").strip()
    )
    if not safe:
        return None
    admin_path = GI_CONTRIB_UPLOAD_DIR / safe
    if admin_path.is_file() and admin_path.stat().st_size > 16:
        return admin_path

    for folder in _gi_local_upload_dirs():
        try:
            source = folder / safe
            if source.is_file() and source.stat().st_size > 16:
                GI_CONTRIB_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, admin_path)
                return admin_path if admin_path.is_file() else source
        except OSError:
            continue

    for url in _gi_remote_fetch_urls(safe):
        body = _fetch_http_bytes(url)
        if not body:
            continue
        try:
            GI_CONTRIB_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            admin_path.write_bytes(body)
            if admin_path.is_file() and admin_path.stat().st_size > 16:
                return admin_path
        except OSError:
            continue
    return None


def _parse_gi_attachments_raw(raw) -> list[dict]:
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
    return [item for item in items if isinstance(item, dict)]


def _collect_gi_attachments_from_row(row: dict) -> list[dict]:
    for key in ("attachments_json", "attachments", "images"):
        parsed = _parse_gi_attachments_raw(row.get(key))
        if parsed:
            return parsed
    doc = str(row.get("gi_document") or "").strip()
    if doc:
        path = f"/uploads/gi_contributions/{os.path.basename(doc)}"
        return [{"name": doc, "filename": doc, "path": path}]
    return []


def _resolve_gi_attachment_urls(attachments: list[dict], *, for_admin: bool = True) -> list[dict]:
    admin_base = _gi_attachment_base_url().rstrip("/")
    app_base = _gi_attachment_base_url(prefer_app_server=True).rstrip("/")
    out: list[dict] = []
    for item in attachments:
        norm = _normalize_gi_attachment(dict(item))
        path = str(norm.get("path") or "").strip()
        if path.startswith(("http://", "https://")):
            try:
                from urllib.parse import urlparse

                path = urlparse(path).path or path
                norm["path"] = path
            except Exception:
                pass
        fname = os.path.basename(path) if path else ""
        if not fname:
            url_hint = str(norm.get("url") or norm.get("name") or norm.get("filename") or "").strip()
            if "/uploads/gi_contributions/" in url_hint:
                fname = os.path.basename(url_hint.split("/uploads/gi_contributions/")[-1].split("?")[0])
            elif url_hint:
                fname = os.path.basename(url_hint)
        if fname:
            _mirror_farmer_gi_file_if_needed(fname)
            rel = f"/uploads/gi_contributions/{fname}"
            norm["path"] = rel
            norm["filename"] = norm.get("filename") or fname
            norm["name"] = norm.get("name") or fname
            if for_admin:
                norm["url"] = rel
            elif admin_base:
                norm["url"] = f"{admin_base}{rel}"
            elif app_base:
                norm["url"] = f"{app_base}{rel}"
            else:
                norm["url"] = rel
            if not norm.get("mime") and not norm.get("type"):
                mime = mimetypes.guess_type(fname)[0] or ""
                if mime:
                    norm["mime"] = mime
                    norm["type"] = mime
            out.append(norm)
            continue

        url = str(norm.get("url") or "").strip()
        if url.startswith(("http://", "https://")):
            if for_admin and "/uploads/gi_contributions/" in url:
                remote_name = os.path.basename(url.split("/uploads/gi_contributions/")[-1].split("?")[0])
                if remote_name and _mirror_farmer_gi_file_if_needed(remote_name):
                    rel = f"/uploads/gi_contributions/{remote_name}"
                    norm["path"] = rel
                    norm["url"] = rel
                else:
                    norm["url"] = url
            else:
                norm["url"] = url
        elif path.startswith("/uploads/gi_contributions/") and admin_base:
            norm["url"] = f"{admin_base}{path}" if not for_admin else path
        elif path.startswith("/") and app_base:
            norm["url"] = f"{app_base}{path}" if not for_admin else path
        elif path and admin_base:
            norm["url"] = f"{admin_base}/{path.lstrip('/')}" if not for_admin else f"/{path.lstrip('/')}"
        elif path:
            norm["url"] = path
        out.append(norm)
    return out


def _save_gi_attachments_from_paths(
    disk_files: list[tuple[str, Path]],
    *,
    base_url: str | None = None,
) -> list[dict]:
    GI_CONTRIB_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    base_url = base_url or _gi_attachment_base_url()
    attachments: list[dict] = []
    for original, path in disk_files[:IPOPHL_GI_MAX_FILES]:
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext not in GI_ALLOWED_EXTENSIONS:
            continue
        size = path.stat().st_size
        if size <= 0 or size > GI_MAX_FILE_BYTES:
            continue
        display = _display_filename(original, path)
        stored = secure_filename(display) or (f"{path.stem[:36]}{ext}" if path.stem else f"{uuid.uuid4().hex}{ext}")
        dest = GI_CONTRIB_UPLOAD_DIR / stored
        # Speed up repeated publishes: avoid re-copying same-sized files.
        # (User often clicks Complete multiple times while debugging.)
        try:
            if dest.exists() and dest.stat().st_size == size:
                pass
            else:
                shutil.copy2(str(path), str(dest))
        except Exception:
            # Fallback if shutil copy fails for any reason.
            dest.write_bytes(path.read_bytes())
        rel = f"/uploads/gi_contributions/{stored}"
        url = f"{base_url.rstrip('/')}{rel}" if base_url else rel
        mime = mimetypes.guess_type(display)[0] or ""
        attachments.append(
            _normalize_gi_attachment(
                {
                    "name": display,
                    "filename": display,
                    "path": rel,
                    "url": url,
                    "mime": mime,
                    "type": mime,
                    "size": size,
                }
            )
        )
    return attachments


def _sync_attachments_to_app_server(disk_files: list[tuple[str, Path]]) -> list[dict]:
    """Upload files to app server :8080 so mobile GI Updates can preview/open them."""
    bases = _gi_app_server_bases()
    if not disk_files or not bases:
        return []
    files = _multipart_files_from_disk(disk_files)
    if not files:
        return []
    fields = {"sync_only": "1"}
    timeout = min(max(30.0, 5.0 * len(files)), 180.0)
    try:
        data = app_http_post_multipart(
            "/api/admin_gi_sync_files.php",
            fields,
            files,
            timeout=timeout,
            bases=bases,
        )
        if isinstance(data, dict) and data.get("ok") is False:
            import logging

            logging.getLogger(__name__).warning(
                "GI file sync rejected: %s", data.get("error") or data
            )
            return []
        raw = data.get("attachments")
        if not isinstance(raw, list) or not raw:
            return []
        base_url = bases[0].rstrip("/")
        out: list[dict] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path") or "").strip()
            url = str(item.get("url") or "").strip()
            if path and not url.startswith("http"):
                url = f"{base_url}{path if path.startswith('/') else '/' + path}"
            out.append(_normalize_gi_attachment({**item, "path": path, "url": url}))
        return out
    except Exception as e:
        import logging

        logging.getLogger(__name__).warning("GI file sync to app server failed: %s", e)
        return []


def _dedupe_disk_files(disk_files: list[tuple[str, Path]]) -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for name, path in disk_files:
        if not path or not path.is_file():
            continue
        key = path.resolve().as_posix()
        if key in seen:
            continue
        seen.add(key)
        out.append((name, path))
    return out


def _build_ipophl_attachment_cache(disk_files: list[tuple[str, Path]]) -> dict[str, dict]:
    """Upload all IPOPHL files to the app server once; map path -> attachment JSON."""
    unique = _dedupe_disk_files(disk_files)
    if not unique:
        return {}
    cache: dict[str, dict] = {}
    synced = _sync_attachments_to_app_server(unique)
    if synced and len(synced) < len(unique):
        import logging

        logging.getLogger(__name__).warning(
            "GI file sync: only %s of %s files reached the app server",
            len(synced),
            len(unique),
        )
    if synced:
        by_display: dict[str, dict] = {}
        by_basename: dict[str, dict] = {}
        for att in synced:
            if not isinstance(att, dict):
                continue
            norm = _normalize_gi_attachment(att)
            label = str(norm.get("name") or norm.get("filename") or "").strip()
            if label:
                by_display[label.lower()] = norm
            p = str(norm.get("path") or "")
            if p:
                by_basename[os.path.basename(p).lower()] = norm
        for i, (name, path) in enumerate(unique):
            key = path.resolve().as_posix()
            display = _display_filename(name, path)
            att = (
                by_display.get(display.lower())
                or by_basename.get(secure_filename(display).lower())
                or by_basename.get(path.name.lower())
                or (dict(synced[i]) if i < len(synced) else None)
            )
            if not att:
                continue
            att = _normalize_gi_attachment({**att, "name": display, "filename": display})
            cache[key] = att
        if cache:
            return cache
    base = _gi_attachment_base_url(prefer_app_server=True) or _public_base_url()
    saved = _save_gi_attachments_from_paths(unique, base_url=base)
    for i, (name, path) in enumerate(unique):
        if i < len(saved):
            cache[path.resolve().as_posix()] = saved[i]
    return cache


def _attachments_from_cache(
    disk_files: list[tuple[str, Path]], cache: dict[str, dict]
) -> list[dict]:
    out: list[dict] = []
    for name, path in disk_files:
        key = path.resolve().as_posix()
        att = cache.get(key)
        if att:
            display = _display_filename(name, path)
            out.append(_normalize_gi_attachment({**att, "name": display, "filename": display}))
    return out


def _prepare_ipophl_attachments(
    disk_files: list[tuple[str, Path]],
    *,
    attachment_cache: dict[str, dict] | None = None,
) -> list[dict]:
    """Prefer app-server copies (mobile preview); fall back to admin-hosted files on same PC."""
    if attachment_cache is not None:
        cached = _attachments_from_cache(disk_files, attachment_cache)
        if cached:
            return cached
    synced = _sync_attachments_to_app_server(disk_files)
    if synced:
        return synced
    base = _gi_attachment_base_url(prefer_app_server=True) or _public_base_url()
    return _save_gi_attachments_from_paths(disk_files, base_url=base)


def _broadcast_admin_submissions_mysql(
    *,
    farmer_ids: list[int],
    title: str,
    content: str,
    category: str,
    attachments: list[dict],
    sender_name: str,
    set_progress_percent: float | None = 100.0,
) -> list[int]:
    """Insert admin_submission rows for many farmers in one transaction (must commit)."""
    # Check if we're using PostgreSQL/Supabase
    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            raise RuntimeError("app_db_host not set in settings.json")
        conn = connect_app_db(params)
    
    if not farmer_ids:
        raise RuntimeError("No farmers found in the database.")

    preview = " ".join(content.split())[:200]
    attachments_json = json.dumps(attachments) if attachments else None
    cat = (category or "general")[:30]
    is_pg = beanthentic_env.is_postgresql()
    created_ids: list[int] = []
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            has_preview = "preview" in _gi_table_columns(cur)
            for fid in farmer_ids:
                if has_preview:
                    sql = """
                        INSERT INTO gi_updates (
                          farmer_id, current_phase, title, content, preview, category,
                          sender_name, attachments_json, upload_status,
                          is_starred, is_read_admin, progress_percent
                        ) VALUES (
                          %s, 'admin_submission', %s, %s, %s, %s,
                          %s, %s, 'approved',
                          %s, %s, %s
                        )
                        """
                    params = (
                        fid,
                        title[:150],
                        content,
                        preview,
                        cat,
                        sender_name[:255],
                        attachments_json,
                        False,
                        True,
                        0,
                    )
                else:
                    sql = """
                        INSERT INTO gi_updates (
                          farmer_id, current_phase, title, content, category,
                          sender_name, attachments_json, upload_status,
                          is_starred, is_read_admin, progress_percent
                        ) VALUES (
                          %s, 'admin_submission', %s, %s, %s,
                          %s, %s, 'approved',
                          %s, %s, %s
                        )
                        """
                    params = (
                        fid,
                        title[:150],
                        content,
                        cat,
                        sender_name[:255],
                        attachments_json,
                        False,
                        True,
                        0,
                    )
                if is_pg:
                    cur.execute(sql + " RETURNING gi_update_id", params)
                    row = cur.fetchone() or {}
                    gid = int(
                        row.get("gi_update_id")
                        if isinstance(row, dict)
                        else (row[0] if row else 0)
                        or 0
                    )
                else:
                    cur.execute(sql, params)
                    gid = int(cur.lastrowid or 0)
                if gid:
                    created_ids.append(gid)
            if len(created_ids) != len(farmer_ids):
                raise RuntimeError(
                    f"GI broadcast incomplete: created {len(created_ids)} of {len(farmer_ids)} "
                    f"farmer rows (ids={created_ids}, farmers={farmer_ids})."
                )
            if set_progress_percent is not None and farmer_ids:
                progress = max(0.0, min(100.0, float(set_progress_percent)))
                note = "GI Registration complete — documents are available in GI Updates."
                for fid in farmer_ids:
                    cur.execute(
                        """
                        INSERT INTO gi_updates
                          (farmer_id, title, content, upload_status, is_read_admin,
                           category, current_phase, progress_percent, sender_name)
                        VALUES
                          (%s, 'GI Progress Update', %s, 'approved', %s,
                           'general', 'admin_progress', %s, %s)
                        """,
                        (fid, note, True, progress, sender_name[:255]),
                    )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()
    return created_ids


def _set_gi_progress_after_ipophl_publish(
    farmer_ids: list[int],
    *,
    progress_percent: float = 100.0,
    note: str = "",
    sender_name: str = "IPOPHL Administrator",
) -> None:
    """Write admin_progress row(s) so mobile GI Process Update bar moves (MySQL or HTTP)."""
    if not farmer_ids:
        return
    if _can_use_app_db():
        try:
            _set_gi_progress_mysql(
                farmer_ids,
                progress_percent,
                note=note,
                sender_name=sender_name,
            )
            return
        except Exception:
            pass
    if not app_server_base() and not _gi_app_server_bases():
        return
    body_note = note or f"GI Registration — {progress_percent:.0f}%"
    for fid in farmer_ids:
        try:
            app_http_patch_json(
                "/api/admin_gi_contributions.php",
                {
                    "action": "set_progress",
                    "farmer_id": fid,
                    "progress_percent": progress_percent,
                    "note": body_note,
                },
                timeout=12.0,
            )
        except Exception:
            continue


def _set_gi_progress_mysql(
    farmer_ids: list[int],
    progress: float,
    *,
    note: str = "",
    sender_name: str = "IPOPHL Administrator",
) -> None:
    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params or not farmer_ids:
            return
        conn = connect_app_db(params)
    
    if not farmer_ids:
        conn.close()
        return
        
    progress = max(0.0, min(100.0, float(progress)))
    body = note or f"GI Registration complete — {progress:.0f}%"
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            for fid in farmer_ids:
                cur.execute(
                    """
                    INSERT INTO gi_updates
                      (farmer_id, title, content, upload_status, is_read_admin,
                       category, current_phase, progress_percent, sender_name)
                    VALUES
                      (%s, 'GI Progress Update', %s, 'approved', %s,
                       'general', 'admin_progress', %s, %s)
                    """,
                    (fid, body[:5000], True, progress, sender_name[:255]),
                )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        conn.close()


def _discover_any_ipophl_disk_files() -> list[tuple[str, Path]]:
    """Last-resort: any publishable file from IPOPHL store or uploads folder."""
    from config.ipophl_store import UPLOADS_DIR, list_documents, resolve_file_path

    out: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for record in list_documents(limit=300):
        uid = str(record.get("file_uuid") or "").strip()
        if not uid:
            continue
        path = resolve_file_path(uid)
        if not path or not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext not in GI_ALLOWED_EXTENSIONS:
            continue
        if path.stat().st_size <= 0:
            continue
        key = path.resolve().as_posix()
        if key in seen:
            continue
        seen.add(key)
        name = str(record.get("original_filename") or path.name)
        out.append((name, path))
        if len(out) >= IPOPHL_GI_MAX_FILES:
            return out
    if UPLOADS_DIR.exists():
        for path in sorted(UPLOADS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if not path.is_file():
                continue
            ext = path.suffix.lower()
            if ext not in GI_ALLOWED_EXTENSIONS:
                continue
            if path.stat().st_size <= 0 or path.stat().st_size > GI_MAX_FILE_BYTES:
                continue
            key = path.resolve().as_posix()
            if key in seen:
                continue
            seen.add(key)
            out.append((path.name, path))
            if len(out) >= IPOPHL_GI_MAX_FILES:
                break
    return out


def _pick_latest_ipophl_file(files: list[tuple[str, Path]]) -> list[tuple[str, Path]]:
    """All attachments for one GI card (one card per IPOPHL document group)."""
    if len(files) <= 1:
        return files
    from config.ipophl_store import get_document

    seen_paths: set[str] = set()
    scored: list[tuple[str, str, str, Path]] = []
    for name, path in files:
        key = path.resolve().as_posix()
        if key in seen_paths:
            continue
        seen_paths.add(key)
        record = get_document(path.stem) or get_document(path.name)
        ts = str((record or {}).get("upload_timestamp") or "")
        scored.append((ts, name, key, path))
    scored.sort(key=lambda row: row[0], reverse=True)
    return [(name, path) for _ts, name, _key, path in scored]


def _delete_ipophl_gi_updates_by_categories(categories: list[str]) -> int:
    """Remove prior IPOPHL admin GI cards so republishing does not duplicate."""
    cats = [str(c or "").strip()[:30] for c in categories if str(c or "").strip()]
    if not cats or not _can_use_app_db():
        return 0
    conn = connect_app_db({}) if beanthentic_env.is_postgresql() else connect_app_db(app_db_params())
    removed = 0
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            placeholders = ",".join(["%s"] * len(cats))
            cur.execute(
                f"""
                DELETE FROM gi_updates
                WHERE current_phase = 'admin_submission'
                  AND sender_name = %s
                  AND category IN ({placeholders})
                """,
                [IPOPHL_GI_SENDER, *cats],
            )
            removed = int(getattr(cur, "rowcount", 0) or 0)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return removed


def sync_ipophl_category_gi_updates(task_id: str | None) -> dict:
    """
    After an IPOPHL file is deleted: clear that category's GI cards and republish
    the latest remaining file for the zone (if any).
    """
    from config.ipophl_store import list_documents, normalize_ipophl_task_id

    tid = normalize_ipophl_task_id(task_id)
    category = tid[:30]
    _delete_ipophl_gi_updates_by_categories([category])

    docs = list_documents(task_id=tid, limit=50)
    uuids = [str(d.get("file_uuid") or "").strip() for d in docs if d.get("file_uuid")]
    uuids = [u for u in uuids if u]
    if not uuids:
        return {"ok": True, "cleared": True, "cards_published": 0}

    return publish_ipophl_registration_to_gi_updates(
        file_uuids=uuids,
        publish_all_categories=False,
        replace_existing=False,
    )


def publish_gi_registration_fallback_to_gi_updates(
    *,
    title: str | None = None,
    content: str | None = None,
) -> dict:
    """
    Always insert at least one admin_submission row (and optional attachment)
    so Complete Registration shows something in app.py GI Updates.
    """
    farmer_ids: list[int] = []
    farmer_list_err: Exception | None = None
    if app_db_params():
        try:
            farmer_ids = _list_active_farmer_ids()
        except Exception as e:
            farmer_list_err = e
    prefer_http = _prefer_http_for_gi_send() and bool(_gi_http_bases())
    if not farmer_ids and not prefer_http:
        if farmer_list_err:
            raise RuntimeError(
                friendly_load_failure(
                    module_label="GI Updates (fallback publish)",
                    mysql_error=farmer_list_err,
                    http_error=None,
                )
            )
        raise ValueError(
            "No farmers in the app database. Add at least one farmer on the mobile app first."
        )

    disk_files = _discover_any_ipophl_disk_files()
    sender_name = "IPOPHL Administrator"
    card_title = (title or "GI Registration — Complete").strip()[:150]
    body = (
        content
        or "Administrator completed GI registration. Documents are listed in GI Updates."
    ).strip()
    if disk_files:
        display = _display_filename(disk_files[0][0], disk_files[0][1])
        body = f"{body}\n\nAttached: {display}"

    mysql_err: Exception | None = None
    http_err: Exception | None = None
    created_ids: list[int] = []
    attachments: list[dict] = []

    if prefer_http and _gi_http_bases():
        try:
            data = _send_gi_via_http(
                send_to_all=True,
                farmer_id=0,
                title=card_title,
                content=body[:5000],
                category="ipophl_registration",
                sender_name=sender_name[:255],
                uploads=[],
                disk_files=disk_files[:1] if disk_files else None,
                http_timeout=60.0,
            )
            if data.get("gi_update_ids"):
                created_ids.extend(int(x) for x in data["gi_update_ids"] if int(x or 0) > 0)
            attachments = data.get("attachments") or attachments
        except Exception as e:
            http_err = e

    if not created_ids and _can_use_app_db() and farmer_ids:
        try:
            attachments = _prepare_ipophl_attachments(disk_files[:1]) if disk_files else []
            created_ids = _broadcast_admin_submissions_mysql(
                farmer_ids=farmer_ids,
                title=card_title,
                content=body[:5000],
                category="ipophl_registration",
                attachments=attachments,
                sender_name=sender_name[:255],
                set_progress_percent=100.0,
            )
        except Exception as e:
            mysql_err = e

    if not created_ids and not prefer_http and _gi_http_bases():
        try:
            data = _send_gi_via_http(
                send_to_all=True,
                farmer_id=0,
                title=card_title,
                content=body[:5000],
                category="ipophl_registration",
                sender_name=sender_name[:255],
                uploads=[],
                disk_files=disk_files[:1] if disk_files else None,
                http_timeout=60.0,
            )
            if data.get("gi_update_ids"):
                created_ids.extend(int(x) for x in data["gi_update_ids"] if int(x or 0) > 0)
            attachments = data.get("attachments") or attachments
        except Exception as e:
            http_err = e

    if not created_ids:
        detail = friendly_load_failure(
            module_label="GI Updates (fallback publish)",
            mysql_error=mysql_err,
            http_error=http_err,
        )
        raise RuntimeError(detail)

    return {
        "ok": True,
        "broadcast": True,
        "cards_published": 1,
        "files_resolved": len(disk_files),
        "files_requested": max(1, len(disk_files)),
        "sent_count": len(farmer_ids),
        "gi_update_ids": created_ids,
        "attachments": attachments,
        "source": "app_mysql" if _can_use_app_db() else "app_server_http",
        "fallback": True,
    }


def publish_ipophl_task_to_gi_updates(
    *,
    file_uuid: str,
    task_id: str | None = None,
) -> dict:
    """Republish one IPOPHL document group (all files in that zone) to GI Updates."""
    from config.ipophl_store import list_documents, normalize_ipophl_task_id

    uid = str(file_uuid or "").strip()
    if not uid:
        raise ValueError("file_uuid is required")
    tid = normalize_ipophl_task_id(task_id)
    uuids: list[str] = []
    seen: set[str] = set()
    if tid and tid != "ipophl-other":
        for doc in list_documents(task_id=tid, limit=100):
            file_id = str(doc.get("file_uuid") or "").strip()
            if file_id and file_id not in seen:
                seen.add(file_id)
                uuids.append(file_id)
    if uid not in seen:
        uuids.append(uid)
    overrides = {u: tid for u in uuids} if tid and tid != "ipophl-other" else None
    return publish_ipophl_registration_to_gi_updates(
        file_uuids=uuids,
        task_overrides=overrides,
        publish_all_categories=False,
        replace_existing=True,
    )


def publish_ipophl_registration_to_gi_updates(
    *,
    file_uuids: list[str],
    title: str | None = None,
    content: str | None = None,
    category: str = "ipophl_registration",
    task_overrides: dict[str, str] | None = None,
    publish_all_categories: bool = False,
    replace_existing: bool = True,
) -> dict:
    """
    Publish IPOPHL to farmers' GI Updates — one feed card per document group (7 MoP zones).
    Each card carries every file attached in that group; republishing replaces the old card.
    """
    from config.ipophl_store import (
        OFFICIAL_IPOPHL_TASK_IDS,
        apply_task_overrides_to_store,
        build_publish_file_entries,
        build_publish_task_groups,
    )

    if task_overrides:
        apply_task_overrides_to_store(task_overrides)

    task_groups = build_publish_task_groups(
        file_uuids,
        task_overrides=task_overrides,
        include_all_categories=publish_all_categories,
    )
    publish_rows = build_publish_file_entries(file_uuids, task_overrides=task_overrides)
    files_on_disk = sum(len(g.get("files") or []) for g in task_groups)

    if not task_groups and file_uuids:
        disk_all = _load_ipophl_disk_files(file_uuids)
        if disk_all:
            task_groups = [
                {
                    "task_id": category or "ipophl_registration",
                    "label": "GI Registration Documents",
                    "files": disk_all,
                }
            ]
            files_on_disk = len(disk_all)

    if not task_groups:
        if file_uuids:
            raise ValueError(
                "Registration files were not found on this device or are empty (0 bytes). "
                "Re-upload documents in IPOPHL, then click Complete Registration again."
            )
        raise ValueError(
            "No registration files found. Upload documents in IPOPHL before completing registration."
        )

    sender_name = IPOPHL_GI_SENDER
    http_err: Exception | None = None
    mysql_err: Exception | None = None
    all_created_ids: list[int] = []
    cards_published = 0
    categories_with_files = 0
    last_attachments: list[dict] = []

    if replace_existing:
        clear_cats: list[str] = []
        for group in task_groups:
            tid = str(group.get("task_id") or "")[:30]
            if not tid:
                continue
            if group.get("files") or publish_all_categories:
                clear_cats.append(tid)
        if clear_cats:
            _delete_ipophl_gi_updates_by_categories(list(dict.fromkeys(clear_cats)))

    prefer_http = _prefer_http_for_gi_send() and bool(_gi_app_server_bases())

    farmer_ids: list[int] = []
    farmer_list_err: Exception | None = None
    if _can_use_app_db() or _gi_app_server_bases():
        try:
            farmer_ids = _list_active_farmer_ids()
        except Exception as e:
            farmer_list_err = e
            mysql_err = e
    if not farmer_ids:
        if farmer_list_err:
            raise RuntimeError(
                friendly_load_failure(
                    module_label="IPOPHL registration (farmer list)",
                    mysql_error=farmer_list_err,
                    http_error=http_err,
                )
            )
        raise ValueError(
            "No farmers in the app database. Add at least one farmer on the mobile app or app server first."
        )

    published_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    used_http = False
    http_sent_count = 0

    all_disk_for_sync: list[tuple[str, Path]] = []
    for group in task_groups:
        all_disk_for_sync.extend(list(group.get("files") or []))
    attachment_cache = _build_ipophl_attachment_cache(all_disk_for_sync)

    mysql_reachable, _mysql_probe_err = probe_app_mysql(timeout=5.0)
    use_mysql_first = mysql_reachable and _can_use_app_db()

    for group in task_groups:
        task_id = str(group.get("task_id") or "ipophl-other")
        label = str(group.get("label") or task_id)
        disk_files: list[tuple[str, Path]] = _pick_latest_ipophl_file(
            list(group.get("files") or [])
        )
        card_title = (title or label).strip()[:150]
        task_category = str(task_id)[:30]

        if not disk_files and not publish_all_categories:
            continue

        if disk_files:
            categories_with_files += 1
            file_lines = "\n".join(
                f"- {_display_filename(name, path)}" for name, path in disk_files
            )
            doc_content = (
                f"{label}\n\n"
                f"Files ({len(disk_files)}):\n{file_lines}\n\n"
                f"Published: {published_at}"
            )
        else:
            doc_content = (
                f"{label}\n\n"
                "No file attached for this category on the admin server yet. "
                "Upload a document in this IPOPHL section, then click Complete Registration again.\n\n"
                f"Published: {published_at}"
            )

        published_this_card = False
        card_attachments = (
            _attachments_from_cache(disk_files, attachment_cache) if disk_files else []
        )
        files_on_app_server = (not disk_files) or (
            len(card_attachments) >= len(disk_files)
        )

        def _publish_card_via_http() -> None:
            nonlocal published_this_card, http_err, last_attachments, used_http, http_sent_count
            if not _gi_app_server_bases():
                return
            try:
                data = _send_gi_via_http(
                    send_to_all=True,
                    farmer_id=0,
                    title=card_title,
                    content=doc_content,
                    category=task_category,
                    sender_name=sender_name[:255],
                    uploads=[],
                    disk_files=disk_files if not card_attachments else None,
                    attachments=card_attachments or None,
                    http_timeout=45.0,
                )
                if data.get("gi_update_ids"):
                    all_created_ids.extend(
                        int(x) for x in data["gi_update_ids"] if int(x or 0) > 0
                    )
                elif data.get("gi_update_id"):
                    all_created_ids.append(int(data["gi_update_id"]))
                if data.get("sent_count") or data.get("gi_update_ids"):
                    published_this_card = True
                    used_http = True
                    http_sent_count = max(
                        http_sent_count, int(data.get("sent_count") or 0)
                    )
                    last_attachments = data.get("attachments") or last_attachments
            except Exception as e:
                if http_err is None:
                    http_err = e

        def _publish_card_via_mysql() -> None:
            nonlocal published_this_card, mysql_err, last_attachments
            if not _can_use_app_db() or not farmer_ids:
                return
            try:
                attachments = card_attachments or (
                    _prepare_ipophl_attachments(
                        disk_files, attachment_cache=attachment_cache
                    )
                    if disk_files
                    else []
                )
                created_ids = _broadcast_admin_submissions_mysql(
                    farmer_ids=farmer_ids,
                    title=card_title,
                    content=doc_content,
                    category=task_category,
                    attachments=attachments,
                    sender_name=sender_name[:255],
                    set_progress_percent=None,
                )
                all_created_ids.extend(created_ids)
                if attachments:
                    last_attachments = attachments
                published_this_card = True
            except Exception as e:
                mysql_err = e

        if disk_files and not files_on_app_server:
            # Batch sync failed — upload files with each card via app server :8080.
            _publish_card_via_http()
        elif use_mysql_first:
            _publish_card_via_mysql()
            if not published_this_card:
                _publish_card_via_http()
        elif prefer_http:
            _publish_card_via_http()
            if not published_this_card:
                _publish_card_via_mysql()
        else:
            _publish_card_via_mysql()
            if not published_this_card:
                _publish_card_via_http()

        if published_this_card:
            cards_published += 1

    if cards_published <= 0:
        detail = friendly_load_failure(
            module_label="IPOPHL registration → GI Updates",
            mysql_error=mysql_err,
            http_error=http_err,
        )
        raise RuntimeError(detail)

    try:
        _set_gi_progress_after_ipophl_publish(
            farmer_ids,
            progress_percent=100.0,
            note="GI Registration complete — documents are in GI Updates.",
            sender_name=sender_name[:255],
        )
    except Exception:
        pass

    if used_http and http_sent_count > 0:
        farmer_count = http_sent_count
    elif farmer_ids:
        farmer_count = len(farmer_ids)
    else:
        farmer_count = len(all_created_ids)
    source = "app_server_http" if used_http else ("app_mysql" if _can_use_app_db() else "app_server_http")
    return {
        "ok": True,
        "broadcast": True,
        "cards_published": cards_published,
        "categories_published": cards_published,
        "categories_total": len(OFFICIAL_IPOPHL_TASK_IDS) if publish_all_categories else len(task_groups),
        "categories_with_files": categories_with_files,
        "files_resolved": files_on_disk or len(publish_rows),
        "files_requested": len(file_uuids),
        "sent_count": farmer_count,
        "gi_update_ids": all_created_ids,
        "attachments": last_attachments,
        "source": source,
    }


def _count_admin_gi_rows() -> int:
    if beanthentic_env.is_postgresql():
        try:
            conn = connect_app_db({})
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) AS c FROM gi_updates "
                    "WHERE current_phase IN ('admin_submission', 'admin_progress')"
                )
                row = cur.fetchone() or {}
                res = int(row.get("c") if isinstance(row, dict) else row[0] if row else 0)
            conn.close()
            return res
        except Exception:
            return 0

    params = app_db_params()
    if not params:
        return 0
    try:
        conn = connect_app_db(params)
    except Exception:
        return 0
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) AS c FROM gi_updates "
                "WHERE current_phase IN ('admin_submission', 'admin_progress')"
            )
            row = cur.fetchone() or {}
            return int(row.get("c") if isinstance(row, dict) else row[0] if row else 0)
    finally:
        conn.close()


def _send_gi_via_http(
    *,
    send_to_all: bool,
    farmer_id: int,
    title: str,
    content: str,
    category: str,
    sender_name: str,
    uploads,
    disk_files: list[tuple[str, Path]] | None = None,
    attachments: list[dict] | None = None,
    http_timeout: float | None = None,
) -> dict:
    fields = {
        "send_to_all": "1" if send_to_all else "0",
        "title": title,
        "content": content,
        "category": category,
        "sender_name": sender_name,
    }
    if not send_to_all and farmer_id > 0:
        fields["farmer_id"] = str(farmer_id)
    files: list[tuple[str, str, bytes, str | None]] = []
    if attachments:
        fields["attachments_json"] = json.dumps(attachments, ensure_ascii=False)
    else:
        files = _upload_files_for_http(uploads)
        files.extend(_multipart_files_from_disk(disk_files or []))
    if len(files) > IPOPHL_GI_MAX_FILES:
        files = files[:IPOPHL_GI_MAX_FILES]
    if http_timeout is None:
        from config.app_connection import app_http_timeout

        http_timeout = min(max(float(app_http_timeout()), 20.0 + len(files) * 6.0), 120.0)
    bases = _gi_app_server_bases()
    if not bases:
        raise RuntimeError("No app server reachable for GI send (port 8080).")
    data = app_http_post_multipart(
        "/api/admin_gi_send.php",
        fields,
        files,
        timeout=http_timeout,
        bases=bases,
    )
    if data.get("ok") or data.get("sent_count") or data.get("gi_update_ids"):
        if not data.get("ok"):
            data["ok"] = True
        return data
    raise RuntimeError(str(data.get("detail") or data.get("error") or "GI send rejected"))


def ensure_gi_farmers_contribution_table(cur) -> None:
    """Farmer compose → admin Farmer's Contribution (not gi_updates)."""
    if beanthentic_env.is_postgresql():
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS gi_farmers_contribution (
              gi_farmer_contribution_id BIGSERIAL PRIMARY KEY,
              farmer_id BIGINT NOT NULL,
              title VARCHAR(150) NOT NULL DEFAULT '',
              content TEXT NOT NULL,
              attachments_json TEXT NULL,
              sender_name VARCHAR(255) NULL,
              category VARCHAR(30) NOT NULL DEFAULT 'general',
              is_read_admin BOOLEAN NOT NULL DEFAULT FALSE,
              is_starred BOOLEAN NOT NULL DEFAULT FALSE,
              ipophi_id VARCHAR(100) NULL,
              gi_document VARCHAR(255) NULL,
              images TEXT NULL,
              upload_status VARCHAR(32) NOT NULL DEFAULT 'pending',
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_gi_fc_farmer ON gi_farmers_contribution (farmer_id);
            CREATE INDEX IF NOT EXISTS idx_gi_fc_status ON gi_farmers_contribution (upload_status, is_read_admin);
            """
        )
        return

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS gi_farmers_contribution (
          gi_farmer_contribution_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          farmer_id BIGINT UNSIGNED NOT NULL,
          title VARCHAR(150) NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          attachments_json TEXT NULL,
          sender_name VARCHAR(255) NULL,
          category VARCHAR(30) NOT NULL DEFAULT 'general',
          is_read_admin TINYINT(1) NOT NULL DEFAULT 0,
          is_starred TINYINT(1) NOT NULL DEFAULT 0,
          ipophi_id VARCHAR(100) NULL,
          gi_document VARCHAR(255) NULL,
          images TEXT NULL,
          upload_status VARCHAR(32) NOT NULL DEFAULT 'pending',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_gi_fc_farmer (farmer_id),
          INDEX idx_gi_fc_status (upload_status, is_read_admin)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """
    )
    for col, ddl in (
        ("title", "VARCHAR(150) NOT NULL DEFAULT ''"),
        ("content", "TEXT NOT NULL"),
        ("attachments_json", "TEXT NULL"),
        ("sender_name", "VARCHAR(255) NULL"),
        ("category", "VARCHAR(30) NOT NULL DEFAULT 'general'"),
        ("is_read_admin", "TINYINT(1) NOT NULL DEFAULT 0"),
        ("is_starred", "TINYINT(1) NOT NULL DEFAULT 0"),
    ):
        try:
            cur.execute(f"ALTER TABLE gi_farmers_contribution ADD COLUMN {col} {ddl}")
        except Exception:
            pass
    try:
        cur.execute(
            "SELECT COUNT(*) AS c FROM gi_farmers_contribution"
        )
        have = int((cur.fetchone() or {}).get("c") or 0)
        cur.execute(
            "SELECT COUNT(*) AS c FROM gi_updates WHERE current_phase = 'farmer_submission'"
        )
        legacy = int((cur.fetchone() or {}).get("c") or 0)
        if have == 0 and legacy > 0:
            cur.execute(
                """
                INSERT INTO gi_farmers_contribution
                  (farmer_id, title, content, attachments_json, upload_status, sender_name,
                   category, is_read_admin, is_starred, images, created_at, updated_at)
                SELECT
                  farmer_id, COALESCE(NULLIF(title, ''), 'GI Update'), content, attachments_json,
                  upload_status, sender_name, COALESCE(NULLIF(category, ''), 'general'),
                  COALESCE(is_read_admin, 0), COALESCE(is_starred, 0), attachments_json,
                  created_at, updated_at
                FROM gi_updates
                WHERE current_phase = 'farmer_submission'
                """
            )
    except Exception:
        pass


def ensure_gi_updates_table(cur) -> None:
    if beanthentic_env.is_postgresql():
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS gi_updates (
              gi_update_id BIGSERIAL PRIMARY KEY,
              farmer_id BIGINT NULL,
              current_phase VARCHAR(100) NOT NULL DEFAULT 'farmer_submission',
              title VARCHAR(150) NOT NULL DEFAULT '',
              content TEXT NOT NULL,
              preview TEXT NULL,
              category VARCHAR(30) NOT NULL DEFAULT 'general',
              sender_name VARCHAR(255) NOT NULL DEFAULT '',
              attachments_json TEXT NULL,
              upload_status VARCHAR(20) NOT NULL DEFAULT 'pending',
              is_starred BOOLEAN NOT NULL DEFAULT FALSE,
              is_read_admin BOOLEAN NOT NULL DEFAULT FALSE,
              is_read_farmer BOOLEAN NOT NULL DEFAULT FALSE,
              progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_gi_phase ON gi_updates (current_phase);
            CREATE INDEX IF NOT EXISTS idx_gi_created ON gi_updates (created_at);
            CREATE INDEX IF NOT EXISTS idx_gi_farmer ON gi_updates (farmer_id);
            """
        )
        cols = _gi_table_columns(cur)
        if "is_read_farmer" not in cols:
            cur.execute(
                "ALTER TABLE gi_updates ADD COLUMN IF NOT EXISTS is_read_farmer BOOLEAN NOT NULL DEFAULT FALSE"
            )
        if "preview" not in cols:
            cur.execute("ALTER TABLE gi_updates ADD COLUMN IF NOT EXISTS preview TEXT NULL")
        if "progress_percent" not in cols:
            cur.execute(
                "ALTER TABLE gi_updates ADD COLUMN IF NOT EXISTS progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00"
            )
        return

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
          is_read_farmer TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NULL,
          INDEX idx_gi_phase (current_phase),
          INDEX idx_gi_created (created_at),
          INDEX idx_gi_farmer (farmer_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """
    )
    cur.execute("SHOW COLUMNS FROM gi_updates LIKE 'is_read_farmer'")
    if not cur.fetchone():
        cur.execute(
            "ALTER TABLE gi_updates ADD COLUMN is_read_farmer TINYINT(1) NOT NULL DEFAULT 0 AFTER is_read_admin"
        )


def _public_base_url() -> str:
    try:
        import beanthentic_env

        base = beanthentic_env.admin_public_base()
        if base:
            return base
    except Exception:
        pass
    try:
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        root = json.loads(settings_path.read_text(encoding="utf-8"))
        if not isinstance(root, dict):
            root = {}
    except Exception:
        root = {}
    sms = root.get("sms") if isinstance(root.get("sms"), dict) else {}
    base = str(sms.get("public_base_url") or "").strip().rstrip("/")
    if base:
        return base
    return app_server_base() or ""


def _save_gi_upload_files(file_items) -> list[dict]:
    GI_CONTRIB_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    base_url = _gi_attachment_base_url()
    attachments: list[dict] = []
    for upload in file_items[:GI_MAX_FILES]:
        if not upload or not getattr(upload, "filename", None):
            continue
        original = secure_filename(upload.filename)
        if not original:
            continue
        ext = Path(original).suffix.lower()
        if ext not in GI_ALLOWED_EXTENSIONS:
            continue
        upload.seek(0, 2)
        size = upload.tell()
        upload.seek(0)
        if size <= 0 or size > GI_MAX_FILE_BYTES:
            continue
        stored = f"{uuid.uuid4().hex}{ext}"
        dest = GI_CONTRIB_UPLOAD_DIR / stored
        upload.save(str(dest))
        rel = f"uploads/gi_contributions/{stored}"
        url = f"{base_url.rstrip('/')}/{rel}" if base_url else rel
        mime = upload.mimetype or mimetypes.guess_type(original)[0] or ""
        attachments.append(
            {
                "name": original,
                "filename": original,
                "path": rel,
                "url": url,
                "mime": mime,
                "type": mime,
                "size": size,
            }
        )
    return attachments


def _parse_gi_attachments(raw, base: str) -> list[dict]:
    del base  # URLs resolved via _resolve_gi_attachment_urls (admin + app server bases).
    return _resolve_gi_attachment_urls(_parse_gi_attachments_raw(raw))


def _gi_row_to_admin_item(row: dict, base: str) -> dict:
    gid = int(row.get("gi_update_id") or row.get("id") or 0)
    content = str(row.get("content") or "").strip()
    preview = str(row.get("preview") or "").strip()
    if not preview and content:
        preview = " ".join(content.split())[:200]
    created = row.get("created_at")
    created_iso = created.isoformat() if hasattr(created, "isoformat") else str(created or "")
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
        "attachments": _resolve_gi_attachment_urls(_collect_gi_attachments_from_row(row)),
        "current_phase": str(row.get("current_phase") or ""),
        "direction": (
            "outbound"
            if str(row.get("current_phase") or "").strip() == "admin_submission"
            else "inbound"
        ),
    }


def _load_from_http(limit: int, *, phase: str | None = None) -> list[dict]:
    phase_key = (phase or "inbox").strip().lower()
    if phase_key in ("all", "both", "everything", "inbox", "farmer_submission"):
        phase_key = "inbox"
    elif phase_key in ("sent", "admin_submission"):
        phase_key = "sent"
    elif phase_key in ("inbox", "farmer_submission"):
        phase_key = "inbox"
    data = app_http_get_json(
        "/api/admin_gi_contributions.php",
        query={"limit": limit, "phase": phase_key},
        timeout=20,
    )
    if not data.get("ok"):
        raise RuntimeError(str(data.get("detail") or data.get("error") or "HTTP load failed"))
    items = data.get("items")
    if not isinstance(items, list):
        return []
    return [row for row in items if isinstance(row, dict)]


def _load_from_mysql(limit: int, *, phase: str | None = None) -> list[dict]:
    base = _gi_attachment_base_url()
    conn = _open_app_db()
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            ensure_gi_farmers_contribution_table(cur)
            args: list = []
            if phase in ("sent", "admin_submission"):
                cur.execute(
                    """
                    SELECT g.*, u.email, u.username, u.phone_number,
                           pi.first_name, pi.last_name
                    FROM gi_updates g
                    LEFT JOIN farmers f ON f.farmer_id = g.farmer_id
                    LEFT JOIN users u ON u.user_id = f.user_id
                    LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
                    WHERE g.current_phase = 'admin_submission'
                    ORDER BY g.created_at DESC, g.gi_update_id DESC
                    LIMIT %s
                    """,
                    (limit,),
                )
            else:
                cur.execute(
                    """
                    SELECT g.gi_farmer_contribution_id AS gi_update_id,
                           g.gi_farmer_contribution_id, g.farmer_id, g.title, g.content,
                           g.attachments_json, g.images, g.gi_document,
                           g.upload_status, g.category, g.sender_name,
                           g.is_starred, g.is_read_admin, g.created_at,
                           u.email, u.username, u.phone_number,
                           pi.first_name, pi.last_name
                    FROM gi_farmers_contribution g
                    LEFT JOIN farmers f ON f.farmer_id = g.farmer_id
                    LEFT JOIN users u ON u.user_id = f.user_id
                    LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
                    ORDER BY g.created_at DESC, g.gi_farmer_contribution_id DESC
                    LIMIT %s
                    """,
                    (limit,),
                )
            items = []
            for row in cur.fetchall() or []:
                fn = str(row.get("first_name") or "").strip()
                ln = str(row.get("last_name") or "").strip()
                farmer_name = (fn + " " + ln).strip() or str(row.get("sender_name") or "Farmer")
                item = _gi_row_to_admin_item({**row, "farmer_name": farmer_name}, base)
                if phase not in ("sent", "admin_submission"):
                    item["current_phase"] = "farmer_submission"
                items.append(item)
            return items
    finally:
        conn.close()


def load_admin_gi_contributions(limit: int = 500, *, phase: str | None = None) -> tuple[list[dict], str]:
    limit = clamp_limit(limit)
    base = _gi_attachment_base_url()

    def _pack_rows(raw_rows: list[dict]) -> list[dict]:
        return [_gi_row_to_admin_item(row, base) for row in raw_rows]

    rest_err: Exception | None = None
    if beanthentic_env.uses_supabase_anon():
        try:
            from config.supabase_gi_load import fetch_gi_contributions_via_rest

            return _pack_rows(fetch_gi_contributions_via_rest(limit=limit, phase=phase)), "supabase_rest"
        except Exception as exc:
            rest_err = exc
            if beanthentic_env.get_db_url():
                try:
                    return _pack_rows(_load_from_mysql(limit, phase=phase)), "supabase_sql"
                except Exception:
                    pass
            from config.app_connection import friendly_load_failure

            raise RuntimeError(
                friendly_load_failure(module_label="GI contributions", mysql_error=rest_err)
            ) from rest_err

    def _http_pack() -> list[dict]:
        items = _load_from_http(limit, phase=phase)
        base = _gi_attachment_base_url()
        return [_gi_row_to_admin_item(row, base) for row in items]

    source_label = "app_server_http"

    def _http_loader() -> list[dict]:
        return _http_pack()

    def _mysql_loader() -> list[dict]:
        return _load_from_mysql(limit, phase=phase)

    from config.app_data_load import load_with_app_bridge

    rows, source = load_with_app_bridge(
        module_label="GI contributions",
        mysql_loader=_mysql_loader,
        http_loader=_http_loader,
    )
    if source == "app_server_http":
        return rows, source_label
    if source == "supabase" or beanthentic_env.is_postgresql():
        return rows, "supabase"
    return rows, "app_mysql"


def _patch_via_http(gi_id: int, fields: dict) -> int:
    body: dict = {"gi_update_id": gi_id}
    if "is_starred" in fields:
        body["is_starred"] = fields["is_starred"]
    if "is_read_admin" in fields:
        body["is_read_admin"] = fields["is_read_admin"]
    if "upload_status" in fields:
        body["upload_status"] = fields["upload_status"]
    data = app_http_patch_json("/api/admin_gi_contributions.php", body)
    if data.get("ok") is False:
        raise RuntimeError(str(data.get("detail") or data.get("error") or "HTTP patch failed"))
    return int(data.get("updated") or 0)


def _delete_via_http(gi_id: int) -> int:
    data = app_http_delete_json(
        "/api/admin_gi_contributions.php",
        query={"gi_update_id": gi_id},
    )
    if data.get("ok") is False:
        raise RuntimeError(str(data.get("detail") or data.get("error") or "HTTP delete failed"))
    return int(data.get("deleted") or 0)


def _patch_mysql(gi_id: int, fields: dict) -> int:
    conn = _open_app_db()
    try:
        with conn.cursor() as cur:
            ensure_gi_farmers_contribution_table(cur)
            sets = []
            args: list = []
            if "is_starred" in fields:
                sets.append("is_starred = %s")
                args.append(_sql_bool(fields["is_starred"]))
            if "is_read_admin" in fields:
                sets.append("is_read_admin = %s")
                args.append(_sql_bool(fields["is_read_admin"]))
            if "upload_status" in fields:
                sets.append("upload_status = %s")
                args.append(fields["upload_status"])
            if not sets:
                return 0
            args.append(gi_id)
            cur.execute(
                f"UPDATE gi_farmers_contribution SET {', '.join(sets)} WHERE gi_farmer_contribution_id = %s",
                tuple(args),
            )
            updated = int(cur.rowcount or 0)
        conn.commit()
        return updated
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _farmer_ids_from_http() -> list[int]:
    data = app_http_get_json(
        "/api/admin_farmer_data.php",
        query={"limit": 2500},
        timeout=12,
        bases=_gi_app_server_bases(),
    )
    if not data.get("ok"):
        raise RuntimeError(str(data.get("error") or "Could not load farmer list from app server"))
    items = data.get("items")
    if not isinstance(items, list):
        return []
    ids: list[int] = []
    for row in items:
        if not isinstance(row, dict):
            continue
        if "farmer_id" not in row:
            continue
        try:
            n = int(row["farmer_id"])
            if n > 0:
                ids.append(n)
        except (TypeError, ValueError):
            continue
    return sorted(set(ids))


def _list_active_farmer_ids() -> list[int]:
    """Load farmer_id list — HTTP first when LAN MySQL is usually blocked."""
    from config.app_connection import prefer_app_http_bridge

    # If using PostgreSQL/Supabase, use that directly
    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT farmer_id
                    FROM farmers
                    WHERE farmer_id IS NOT NULL
                    ORDER BY farmer_id ASC
                    """
                )
                rows = cur.fetchall() or []
                ids: list[int] = []
                for row in rows:
                    try:
                        fid = int(row.get("farmer_id") or 0)
                    except (TypeError, ValueError):
                        fid = 0
                    if fid > 0:
                        ids.append(fid)
                if not ids:
                    raise RuntimeError("No farmers in app database")
                return ids
        finally:
            conn.close()

    def _from_mysql() -> list[int]:
        conn = _open_app_db()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT farmer_id
                    FROM farmers
                    WHERE farmer_id IS NOT NULL
                    ORDER BY farmer_id ASC
                    """
                )
                rows = cur.fetchall() or []
                ids: list[int] = []
                for row in rows:
                    try:
                        fid = int(row.get("farmer_id") or 0)
                    except (TypeError, ValueError):
                        fid = 0
                    if fid > 0:
                        ids.append(fid)
                if not ids:
                    raise RuntimeError("No farmers in app database")
                return ids
        finally:
            conn.close()

    if prefer_app_http_bridge() and app_server_base():
        try:
            return _farmer_ids_from_http()
        except Exception:
            pass
        try:
            return _from_mysql()
        except Exception:
            pass
    else:
        if app_db_params():
            try:
                return _from_mysql()
            except Exception:
                pass
        if app_server_base():
            return _farmer_ids_from_http()
    raise RuntimeError("app_db_host or app_server_base required in settings.json")


def _insert_admin_submission(
    *,
    farmer_id: int,
    title: str,
    content: str,
    category: str,
    attachments: list[dict],
    sender_name: str = "Administrator",
) -> int:
    if not _can_use_app_db():
        raise RuntimeError("app database not configured in settings.json")
    preview = " ".join(content.split())[:200]
    attachments_json = json.dumps(attachments) if attachments else None
    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            raise RuntimeError("app_db_host not set in settings.json")
        conn = connect_app_db(params)
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            has_preview = "preview" in _gi_table_columns(cur)
            if has_preview:
                sql = """
                    INSERT INTO gi_updates (
                      farmer_id, current_phase, title, content, preview, category,
                      sender_name, attachments_json, upload_status,
                      is_starred, is_read_admin, progress_percent
                    ) VALUES (
                      %s, 'admin_submission', %s, %s, %s, %s,
                      %s, %s, 'approved',
                      %s, %s, %s
                    )
                    """
                params = (
                    farmer_id,
                    title,
                    content,
                    preview,
                    category,
                    sender_name,
                    attachments_json,
                    False,
                    True,
                    0,
                )
            else:
                sql = """
                    INSERT INTO gi_updates (
                      farmer_id, current_phase, title, content, category,
                      sender_name, attachments_json, upload_status,
                      is_starred, is_read_admin, progress_percent
                    ) VALUES (
                      %s, 'admin_submission', %s, %s, %s,
                      %s, %s, 'approved',
                      %s, %s, %s
                    )
                    """
                params = (
                    farmer_id,
                    title,
                    content,
                    category,
                    sender_name,
                    attachments_json,
                    False,
                    True,
                    0,
                )
            if beanthentic_env.is_postgresql():
                cur.execute(sql + " RETURNING gi_update_id", params)
                row = cur.fetchone() or {}
                gid = int(
                    row.get("gi_update_id")
                    if isinstance(row, dict)
                    else (row[0] if row else 0)
                    or 0
                )
            else:
                cur.execute(sql, params)
                gid = int(cur.lastrowid or 0)
        conn.commit()
        return gid
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def _gi_table_columns(cur) -> set[str]:
    if beanthentic_env.is_postgresql():
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'gi_updates'
            """
        )
        return {
            str(row.get("column_name") or row[0]).lower()
            for row in (cur.fetchall() or [])
        }
    cur.execute("SHOW COLUMNS FROM gi_updates")
    return {str(row.get("Field") or row[0]).lower() for row in (cur.fetchall() or [])}


def handle_gi_contributions_send():
    """Send a GI update with attachments to one farmer or all farmers (mobile app inbox)."""
    if not is_authenticated():
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    send_to_all_raw = str(request.form.get("send_to_all") or request.form.get("broadcast") or "").strip().lower()
    send_to_all = send_to_all_raw in ("1", "true", "yes", "all", "on")

    try:
        farmer_id = int(request.form.get("farmer_id") or 0)
    except (TypeError, ValueError):
        farmer_id = 0
    if send_to_all:
        farmer_id = 0

    title = str(request.form.get("title") or request.form.get("subject") or "").strip()
    content = str(request.form.get("content") or request.form.get("message") or "").strip()
    category = str(request.form.get("category") or "general").strip().lower() or "general"
    sender_name = str(request.form.get("sender_name") or "Administrator").strip() or "Administrator"

    if not title:
        title = "GI Update from Admin"
    if not content:
        return jsonify({"ok": False, "error": "Message content is required"}), 400

    uploads = request.files.getlist("files") or request.files.getlist("file") or []
    if not uploads and "file" in request.files:
        uploads = [request.files["file"]]

    http_err: Exception | None = None
    mysql_err: Exception | None = None

    if _prefer_http_for_gi_send() and _gi_http_bases():
        try:
            data = _send_gi_via_http(
                send_to_all=send_to_all or farmer_id < 1,
                farmer_id=farmer_id,
                title=title[:255],
                content=content,
                category=category[:64],
                sender_name=sender_name[:255],
                uploads=uploads,
            )
            return jsonify({"ok": True, **data})
        except Exception as e:
            http_err = e

    try:
        attachments = _save_gi_upload_files(uploads)
        if send_to_all or farmer_id < 1:
            farmer_ids = _list_active_farmer_ids()
            if not farmer_ids:
                return jsonify({"ok": False, "error": "No farmers found in the database."}), 400
            created_ids = _broadcast_admin_submissions_mysql(
                farmer_ids=farmer_ids,
                title=title[:255],
                content=content,
                category=category,
                attachments=attachments,
                sender_name=sender_name[:255],
                set_progress_percent=None,
            )
            return jsonify(
                {
                    "ok": True,
                    "broadcast": True,
                    "sent_count": len(created_ids),
                    "gi_update_ids": created_ids,
                    "attachments": attachments,
                }
            )

        gi_id = _insert_admin_submission(
            farmer_id=farmer_id,
            title=title[:255],
            content=content,
            category=category[:64],
            attachments=attachments,
            sender_name=sender_name[:255],
        )
        base = _public_base_url()
        item = _gi_row_to_admin_item(
            {
                "gi_update_id": gi_id,
                "farmer_id": farmer_id,
                "current_phase": "admin_submission",
                "title": title,
                "content": content,
                "preview": " ".join(content.split())[:200],
                "category": category,
                "sender_name": sender_name,
                "attachments_json": json.dumps(attachments) if attachments else None,
                "upload_status": "approved",
                "is_starred": 0,
                "is_read_admin": 1,
                "created_at": datetime.utcnow(),
            },
            base,
        )
        return jsonify({"ok": True, "gi_update_id": gi_id, "item": item, "attachments": attachments})
    except Exception as e:
        mysql_err = e

    detail = friendly_load_failure(
        module_label="GI update send",
        mysql_error=mysql_err,
        http_error=http_err,
    )
    return jsonify({"ok": False, "error": detail, "message": detail, "detail": detail}), 503


def register_gi_contributions_routes(app) -> None:
    @app.route("/uploads/gi_contributions/<path:filename>", methods=["GET"])
    def serve_gi_contribution_upload(filename: str):
        safe = secure_filename(os.path.basename(filename)) or os.path.basename(filename)
        if not safe:
            abort(404)
        local = _ensure_gi_file_on_disk(safe)
        if local and local.is_file():
            return send_from_directory(GI_CONTRIB_UPLOAD_DIR, safe)
        abort(404)

    @app.route("/api/gi-contributions/ensure-attachment", methods=["GET"])
    def api_gi_contribution_ensure_attachment():
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        raw_name = str(request.args.get("filename") or request.args.get("file") or "").strip()
        safe = secure_filename(os.path.basename(raw_name)) or os.path.basename(raw_name)
        if not safe:
            return jsonify({"ok": False, "error": "Missing filename"}), 400
        local = _ensure_gi_file_on_disk(safe)
        if not local or not local.is_file():
            return jsonify({"ok": False, "error": "Attachment not found"}), 404
        rel = f"/uploads/gi_contributions/{safe}"
        mime = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        return jsonify({"ok": True, "url": rel, "filename": safe, "mime": mime, "size": local.stat().st_size})

    @app.route("/api/gi-contributions-list", methods=["GET"])
    def api_gi_contributions_list():
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized", "items": []}), 401
        limit = clamp_limit(request.args.get("limit", type=int) or 500)
        phase = str(request.args.get("phase") or request.args.get("folder") or "inbox").strip().lower()
        try:
            items, source = load_admin_gi_contributions(limit, phase=phase)
            if not isinstance(items, list):
                items = []
            return jsonify({"ok": True, "items": items, "count": len(items), "source": source, "phase": phase})
        except Exception as e:
            from config.app_connection import friendly_load_failure, load_error_payload

            message = friendly_load_failure(module_label="GI contributions", mysql_error=e)
            payload = load_error_payload("GI_CONTRIBUTIONS_LOAD_FAILED", message)
            return jsonify(payload), 503

    @app.route("/api/gi-contributions-farmer-count", methods=["GET"])
    def api_gi_contributions_farmer_count():
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        try:
            count = len(_list_active_farmer_ids())
            return jsonify({"ok": True, "count": count})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e), "count": 0}), 500

    for _send_path in (
        "/api/gi-contributions-send",
        "/api/gi-contributions/send",
        "/api/gi-contributions/broadcast",
    ):
        app.add_url_rule(_send_path, endpoint=f"gi_contributions_send_{_send_path.strip('/').replace('/', '_')}", view_func=handle_gi_contributions_send, methods=["POST"])

    @app.route("/api/gi-contributions/<int:gi_id>", methods=["PATCH", "DELETE"])
    def api_gi_contribution_item(gi_id: int):
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        if gi_id < 1:
            return jsonify({"ok": False, "error": "Invalid contribution id"}), 400

        if request.method == "DELETE":
            deleted = 0
            mysql_err: Exception | None = None
            if _can_use_app_db():
                try:
                    conn = _open_app_db()
                    try:
                        with conn.cursor() as cur:
                            ensure_gi_farmers_contribution_table(cur)
                            cur.execute(
                                "DELETE FROM gi_farmers_contribution WHERE gi_farmer_contribution_id = %s",
                                (gi_id,),
                            )
                            deleted = int(cur.rowcount or 0)
                        conn.commit()
                    except Exception:
                        try:
                            conn.rollback()
                        except Exception:
                            pass
                        raise
                    finally:
                        conn.close()
                except Exception as e:
                    mysql_err = e
            if deleted <= 0 and app_server_base():
                try:
                    deleted = _delete_via_http(gi_id)
                except Exception as http_e:
                    if mysql_err:
                        return jsonify(
                            {
                                "ok": False,
                                "error": friendly_load_failure(
                                    module_label="GI contribution delete",
                                    mysql_error=mysql_err,
                                    http_error=http_e,
                                ),
                            }
                        ), 503
                    return jsonify({"ok": False, "error": str(http_e)}), 500
            elif deleted <= 0 and mysql_err:
                return jsonify({"ok": False, "error": str(mysql_err)}), 503
            if deleted <= 0:
                return jsonify({"ok": False, "error": "Contribution not found"}), 404
            return jsonify({"ok": True, "deleted": deleted})

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

        updated = 0
        mysql_err: Exception | None = None
        if app_db_params():
            try:
                updated = _patch_mysql(gi_id, fields)
            except Exception as e:
                mysql_err = e
        if updated <= 0 and app_server_base():
            try:
                updated = _patch_via_http(gi_id, fields)
            except Exception as http_e:
                if mysql_err:
                    return jsonify(
                        {
                            "ok": False,
                            "error": friendly_load_failure(
                                module_label="GI contribution update",
                                mysql_error=mysql_err,
                                http_error=http_e,
                            ),
                        }
                    ), 503
                return jsonify({"ok": False, "error": str(http_e)}), 500
        elif mysql_err and updated <= 0:
            return jsonify({"ok": False, "error": str(mysql_err)}), 503
        if updated <= 0:
            return jsonify({"ok": False, "error": "Contribution not found"}), 404
        return jsonify({"ok": True, "updated": updated})
