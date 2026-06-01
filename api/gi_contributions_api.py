"""
GI Farmer contributions — mobile app (gi_updates) ↔ admin Farmer's Contribution inbox.
"""

from __future__ import annotations

import json
import mimetypes
import re
import uuid
from datetime import datetime
from pathlib import Path
from flask import jsonify, request
from werkzeug.utils import secure_filename

from config.app_connection import (
    GI_UPLOAD_STATUSES,
    app_db_params,
    app_server_base,
    clamp_limit,
    friendly_load_failure,
    is_loopback_host,
    iter_app_server_bases,
    load_error_payload,
    read_connection_settings,
)
from config.app_http_bridge import app_http_delete_json, app_http_get_json, app_http_patch_json, app_http_post_multipart
from config.mysql_app_bridge import connect_app_mysql
from config.utils import is_authenticated

GI_CONTRIB_UPLOAD_DIR = Path(__file__).resolve().parents[1] / "uploads" / "gi_contributions"
GI_ALLOWED_EXTENSIONS = frozenset(
    {".pdf", ".doc", ".docx", ".txt", ".md", ".csv", ".jpg", ".jpeg", ".png", ".gif", ".webp"}
)
GI_MAX_FILE_BYTES = 15 * 1024 * 1024
GI_MAX_FILES = 5
IPOPHL_GI_MAX_FILES = 30


def _gi_http_bases() -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()

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
    sms = root.get("sms") if isinstance(root.get("sms"), dict) else {}
    gw = sms.get("sms_gateway") if isinstance(sms.get("sms_gateway"), dict) else {}
    add(str(gw.get("local_base_url") or ""))
    conn = root.get("connection") if isinstance(root.get("connection"), dict) else {}
    add(str(conn.get("app_server_base") or ""))
    for base in iter_app_server_bases():
        add(base)
    return ordered


def _prefer_http_for_gi_send() -> bool:
    params = app_db_params()
    if not params:
        return bool(_gi_http_bases())
    host = str(params.get("host") or "").strip()
    if is_loopback_host(host):
        return False
    return bool(_gi_http_bases())


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
                "files",
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


def _unique_multipart_filename(original: str, path: Path) -> str:
    """
    Unique multipart filename so the app server keeps every file.
    Duplicate 'uploaded.docx' parts would otherwise overwrite each other.
    """
    ext = path.suffix.lower() if path.suffix else ""
    if ext not in GI_ALLOWED_EXTENSIONS:
        ext = Path(_display_filename(original, path)).suffix.lower() or ".bin"
    stem = path.stem[:36] if path.stem else uuid.uuid4().hex
    label = Path(_display_filename(original, path)).stem[:60] or "document"
    label = re.sub(r"[^a-zA-Z0-9._-]+", "_", label).strip("._") or "document"
    return f"{label}_{stem}{ext}"


def _multipart_files_from_disk(disk_files: list[tuple[str, Path]]) -> list[tuple[str, str, bytes, str | None]]:
    """Build HTTP multipart file tuples from files on disk (e.g. IPOPHL uploads on admin web.py)."""
    out: list[tuple[str, str, bytes, str | None]] = []
    for original, path in disk_files[:IPOPHL_GI_MAX_FILES]:
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext not in GI_ALLOWED_EXTENSIONS:
            continue
        size = path.stat().st_size
        if size <= 0 or size > GI_MAX_FILE_BYTES:
            continue
        upload_name = _unique_multipart_filename(original, path)
        mime = mimetypes.guess_type(upload_name)[0] or mimetypes.guess_type(path.name)[0]
        out.append(("files", upload_name, path.read_bytes(), mime))
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
    from config.app_connection import app_server_base

    app_base = (app_server_base() or "").strip().rstrip("/")
    admin_base = _public_base_url().strip().rstrip("/")
    if prefer_app_server and app_base:
        return app_base
    if app_base:
        return app_base
    return admin_base


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
        stored = f"{path.stem[:36]}{ext}" if path.stem else f"{uuid.uuid4().hex}{ext}"
        dest = GI_CONTRIB_UPLOAD_DIR / stored
        dest.write_bytes(path.read_bytes())
        rel = f"uploads/gi_contributions/{stored}"
        url = f"{base_url.rstrip('/')}/{rel}" if base_url else rel
        mime = mimetypes.guess_type(display)[0] or ""
        attachments.append(
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
    return attachments


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
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set in settings.json")
    if not farmer_ids:
        raise RuntimeError("No farmers found in the database.")

    preview = " ".join(content.split())[:200]
    attachments_json = json.dumps(attachments) if attachments else None
    cat = (category or "general")[:30]
    conn = connect_app_mysql(params)
    created_ids: list[int] = []
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            has_preview = "preview" in _gi_table_columns(cur)
            for fid in farmer_ids:
                cur.execute(
                    """
                    INSERT INTO gi_updates (
                      farmer_id, current_phase, title, content, category,
                      sender_name, attachments_json, upload_status,
                      is_starred, is_read_admin, progress_percent
                    ) VALUES (
                      %s, 'admin_submission', %s, %s, %s,
                      %s, %s, 'approved',
                      0, 1, 0
                    )
                    """,
                    (
                        fid,
                        title[:150],
                        content,
                        cat,
                        sender_name[:255],
                        attachments_json,
                    ),
                )
                gid = int(cur.lastrowid or 0)
                if gid and has_preview:
                    try:
                        cur.execute(
                            "UPDATE gi_updates SET preview = %s WHERE gi_update_id = %s",
                            (preview, gid),
                        )
                    except Exception:
                        pass
                if gid:
                    created_ids.append(gid)
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
                          (%s, 'GI Progress Update', %s, 'approved', 1,
                           'general', 'admin_progress', %s, %s)
                        """,
                        (fid, note, progress, sender_name[:255]),
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


def _set_gi_progress_mysql(
    farmer_ids: list[int],
    progress: float,
    *,
    note: str = "",
    sender_name: str = "IPOPHL Administrator",
) -> None:
    params = app_db_params()
    if not params or not farmer_ids:
        return
    progress = max(0.0, min(100.0, float(progress)))
    body = note or f"GI Registration complete — {progress:.0f}%"
    conn = connect_app_mysql(params)
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
                      (%s, 'GI Progress Update', %s, 'approved', 1,
                       'general', 'admin_progress', %s, %s)
                    """,
                    (fid, body[:5000], progress, sender_name[:255]),
                )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        conn.close()


def publish_ipophl_registration_to_gi_updates(
    *,
    file_uuids: list[str],
    title: str | None = None,
    content: str | None = None,
    category: str = "ipophl_registration",
    task_overrides: dict[str, str] | None = None,
) -> dict:
    """
    Publish IPOPHL files to farmers' GI Updates — one feed card per document category
    (Product Documentation, Filing Documents, etc.), like separate Facebook posts.
    """
    from config.ipophl_store import group_disk_files_by_task, task_label

    groups = group_disk_files_by_task(file_uuids, task_overrides=task_overrides)
    if not groups:
        if file_uuids:
            raise ValueError(
                "Registration files were not found on this device or are empty (0 bytes). "
                "Re-upload documents in IPOPHL, then click Complete Registration again."
            )
        raise ValueError(
            "No registration files found. Upload documents in IPOPHL before completing registration."
        )

    sender_name = "IPOPHL Administrator"
    http_err: Exception | None = None
    mysql_err: Exception | None = None
    all_created_ids: list[int] = []
    cards_published = 0
    last_attachments: list[dict] = []

    file_entries: list[tuple[str, str, str, Path]] = []
    for task_id, disk_files in groups.items():
        label = task_label(task_id)
        for original, path in disk_files:
            file_entries.append((task_id, label, original, path))

    farmer_ids: list[int] = []
    if app_db_params():
        try:
            farmer_ids = _list_active_farmer_ids()
        except Exception as e:
            mysql_err = e
    if app_db_params() and not farmer_ids:
        raise ValueError(
            "No farmers in the app database. Add at least one farmer on the mobile app or app server first."
        )

    attach_base = (_public_base_url() or "").strip().rstrip("/") or _gi_attachment_base_url()

    for task_id, label, original, path in file_entries:
        display = _display_filename(original, path)
        card_title = (title or label).strip()[:150]
        doc_content = (
            f"{label}\n\n"
            f"File: {display}\n\n"
            f"Published: {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC"
        )
        task_category = str(task_id)[:30]
        single = [(original, path)]

        published_this_card = False

        # 1) MySQL first — always commits so Complete Registration saves even if :8080 HTTP fails.
        if app_db_params() and farmer_ids:
            try:
                attachments = _save_gi_attachments_from_paths(single, base_url=attach_base)
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
                last_attachments = attachments
                published_this_card = True
            except Exception as e:
                mysql_err = e

        # 2) HTTP fallback only if MySQL did not save this card (sync files to app server).
        if not published_this_card and _gi_http_bases():
            try:
                data = _send_gi_via_http(
                    send_to_all=True,
                    farmer_id=0,
                    title=card_title,
                    content=doc_content,
                    category=task_category,
                    sender_name=sender_name[:255],
                    uploads=[],
                    disk_files=single,
                    http_timeout=60.0,
                )
                if data.get("gi_update_ids"):
                    all_created_ids.extend(
                        int(x) for x in data["gi_update_ids"] if int(x or 0) > 0
                    )
                elif data.get("gi_update_id"):
                    all_created_ids.append(int(data["gi_update_id"]))
                if data.get("sent_count") or data.get("gi_update_ids"):
                    published_this_card = True
                    last_attachments = data.get("attachments") or last_attachments
            except Exception as e:
                if http_err is None:
                    http_err = e

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
        farmer_ids = _list_active_farmer_ids()
        _set_gi_progress_mysql(
            farmer_ids,
            100.0,
            note="GI Registration complete — all IPOPHL document categories are in GI Updates.",
            sender_name=sender_name[:255],
        )
    except Exception:
        pass

    farmer_count = len(farmer_ids) if farmer_ids else 0
    source = "app_mysql" if app_db_params() and cards_published else "app_server_http"
    return {
        "ok": True,
        "broadcast": True,
        "cards_published": cards_published,
        "sent_count": farmer_count,
        "gi_update_ids": all_created_ids,
        "attachments": last_attachments,
        "source": source,
    }


def _count_admin_gi_rows() -> int:
    params = app_db_params()
    if not params:
        return 0
    conn = connect_app_mysql(params)
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
    files = _upload_files_for_http(uploads)
    files.extend(_multipart_files_from_disk(disk_files or []))
    if len(files) > IPOPHL_GI_MAX_FILES:
        files = files[:IPOPHL_GI_MAX_FILES]
    if http_timeout is None:
        from config.app_connection import app_http_timeout

        http_timeout = max(float(app_http_timeout()), 20.0 + len(files) * 8.0)
    last_err: Exception | None = None
    for base in _gi_http_bases():
        try:
            data = app_http_post_multipart(
                "/api/admin_gi_send.php", fields, files, timeout=http_timeout
            )
            if data.get("ok") or data.get("sent_count") or data.get("gi_update_ids"):
                if not data.get("ok"):
                    data["ok"] = True
                return data
            last_err = RuntimeError(str(data.get("detail") or data.get("error") or "GI send rejected"))
        except Exception as e:
            last_err = e
    if last_err:
        raise last_err
    raise RuntimeError("No app server reachable for GI send (port 8080).")


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
    cfg = read_connection_settings()
    sms = cfg.get("sms") if isinstance(cfg.get("sms"), dict) else {}
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
        "direction": (
            "outbound"
            if str(row.get("current_phase") or "").strip() == "admin_submission"
            else "inbound"
        ),
    }


def _load_from_http(limit: int, *, phase: str | None = None) -> list[dict]:
    phase_key = (phase or "inbox").strip().lower()
    if phase_key in ("sent", "admin_submission"):
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
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set in settings.json")
    base = app_server_base()
    conn = connect_app_mysql(params)
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            where = "1=1"
            args: list = []
            if phase == "farmer_submission":
                where = "g.current_phase = 'farmer_submission'"
            elif phase == "admin_submission":
                where = "g.current_phase = 'admin_submission'"
            elif phase == "inbox":
                where = "g.current_phase = 'farmer_submission'"
            elif phase == "sent":
                where = "g.current_phase = 'admin_submission'"
            cur.execute(
                f"""
                SELECT g.*, u.email, u.username, u.phone_number,
                       pi.first_name, pi.last_name
                FROM gi_updates g
                LEFT JOIN farmers f ON f.farmer_id = g.farmer_id
                LEFT JOIN users u ON u.user_id = f.user_id
                LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
                WHERE {where}
                ORDER BY g.created_at DESC, g.gi_update_id DESC
                LIMIT %s
                """,
                (*args, limit),
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


def load_admin_gi_contributions(limit: int = 500, *, phase: str | None = None) -> tuple[list[dict], str]:
    limit = clamp_limit(limit)
    mysql_err: Exception | None = None
    http_err: Exception | None = None
    try:
        return _load_from_mysql(limit, phase=phase), "mysql"
    except Exception as e:
        print(f"GI Contributions MySQL error: {e}")
        mysql_err = e
    try:
        items = _load_from_http(limit, phase=phase)
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
    data = app_http_get_json("/api/admin_farmer_data.php", query={"limit": 2500}, timeout=15)
    if not data.get("ok"):
        raise RuntimeError(str(data.get("error") or "Could not load farmer list from app server"))
    items = data.get("items")
    if not isinstance(items, list):
        return []
    ids: list[int] = []
    for row in items:
        if not isinstance(row, dict):
            continue
        for key in ("farmer_id", "user_id", "NO.", "NO", "no"):
            if key not in row:
                continue
            try:
                n = int(row[key])
                if n > 0:
                    ids.append(n)
                    break
            except (TypeError, ValueError):
                continue
    return sorted(set(ids))


def _list_active_farmer_ids() -> list[int]:
    params = app_db_params()
    if params:
        try:
            conn = connect_app_mysql(params)
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
                    if ids:
                        return ids
            finally:
                conn.close()
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
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set in settings.json")
    preview = " ".join(content.split())[:200]
    attachments_json = json.dumps(attachments) if attachments else None
    conn = connect_app_mysql(params)
    try:
        with conn.cursor() as cur:
            ensure_gi_updates_table(cur)
            cur.execute(
                """
                INSERT INTO gi_updates (
                  farmer_id, current_phase, title, content, category,
                  sender_name, attachments_json, upload_status,
                  is_starred, is_read_admin, progress_percent
                ) VALUES (
                  %s, 'admin_submission', %s, %s, %s,
                  %s, %s, 'approved',
                  0, 1, 0
                )
                """,
                (
                    farmer_id,
                    title,
                    content,
                    category,
                    sender_name,
                    attachments_json,
                ),
            )
            gid = int(cur.lastrowid or 0)
            if "preview" in _gi_table_columns(cur):
                try:
                    cur.execute(
                        "UPDATE gi_updates SET preview = %s WHERE gi_update_id = %s",
                        (preview, gid),
                    )
                except Exception:
                    pass
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
            payload = load_error_payload("GI_CONTRIBUTIONS_LOAD_FAILED", str(e))
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
            if app_db_params():
                try:
                    params = app_db_params()
                    conn = connect_app_mysql(params)
                    try:
                        with conn.cursor() as cur:
                            cur.execute(
                                "DELETE FROM gi_updates WHERE gi_update_id = %s AND current_phase = 'farmer_submission'",
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
