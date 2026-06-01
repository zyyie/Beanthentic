"""
Load shared_messages from Beanthentic-App via MySQL (settings.json) or HTTP fallback.

Matches /api/farmer-data: try direct MySQL first when app_db_host is set (works from
other PCs on the LAN when port 3306 is open). If MySQL fails, use app_server_base HTTP
(admin_shared_messages.php or chat_thread.php on the XAMPP device).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from config.app_connection import (
    app_db_params,
    app_http_timeout,
    app_server_base,
    clamp_limit,
    is_loopback_host,
    iter_app_server_bases,
    lan_mysql_fallback_hosts,
)
from config.mysql_app_bridge import connect_app_mysql


class MessagesLoadError(Exception):
    def __init__(
        self,
        mysql_error: BaseException | None = None,
        http_error: BaseException | None = None,
    ) -> None:
        self.mysql_error = mysql_error
        self.http_error = http_error
        super().__init__(self.__str__())

    def __str__(self) -> str:
        parts = []
        if self.mysql_error:
            parts.append(f"MySQL: {self.mysql_error}")
        if self.http_error:
            parts.append(f"HTTP: {self.http_error}")
        return "; ".join(parts) if parts else "Messages load failed"


def _ensure_shared_messages_table(conn) -> None:
    with conn.cursor() as cur:
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


def _normalize_shared_message_row(row: dict) -> dict:
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


def _phone_tail(phone: str) -> str:
    d = re.sub(r"\D", "", str(phone or ""))
    if d.startswith("0"):
        d = d[1:]
    if d.startswith("63"):
        d = d[2:]
    return d


def _phone_matches(a: str, b: str) -> bool:
    ta, tb = _phone_tail(a), _phone_tail(b)
    return bool(ta and tb and ta == tb)


def _http_get_json(url: str, *, timeout: float | None = None) -> dict:
    if timeout is None:
        timeout = app_http_timeout()
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    data = json.loads(raw) if raw else {}
    return data if isinstance(data, dict) else {}


def _read_settings_root() -> dict:
    try:
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _messaging_http_bases() -> list[str]:
    """App-server URLs for messages — prefers sms_gateway.local_base_url (XAMPP device)."""
    ordered: list[str] = []
    seen: set[str] = set()

    def add(url: str | None) -> None:
        base = (url or "").strip().rstrip("/")
        if base and base not in seen:
            seen.add(base)
            ordered.append(base)

    root = _read_settings_root()
    sms = root.get("sms") if isinstance(root.get("sms"), dict) else {}
    gw = sms.get("sms_gateway") if isinstance(sms.get("sms_gateway"), dict) else {}
    add(str(gw.get("local_base_url") or ""))
    add(str(sms.get("public_base_url") or "").replace(":5000", ":8080"))
    for base in iter_app_server_bases():
        add(base)
    return ordered


def _messaging_mysql_hosts() -> list[str]:
    params = app_db_params()
    if not params:
        return []
    hosts: list[str] = []
    seen: set[str] = set()
    primary = str(params.get("host") or "").strip()
    if primary:
        seen.add(primary)
        hosts.append(primary)
    for host in lan_mysql_fallback_hosts():
        if host not in seen:
            seen.add(host)
            hosts.append(host)
    gw = ((_read_settings_root().get("sms") or {}).get("sms_gateway") or {})
    local = str(gw.get("local_base_url") or "")
    if "://" in local:
        from urllib.parse import urlparse

        h = (urlparse(local).hostname or "").strip()
        if h and h not in seen:
            hosts.append(h)
    return hosts


def connect_messaging_mysql():
    """MySQL for shared_messages — tries every LAN host before failing."""
    params = app_db_params()
    if not params:
        return None
    last_err: Exception | None = None
    for host in _messaging_mysql_hosts():
        try:
            conn = connect_app_mysql({**params, "host": host})
            _ensure_shared_messages_table(conn)
            return conn
        except Exception as e:
            last_err = e
    if last_err:
        raise last_err
    return None


def _http_post_json(path: str, body: dict) -> dict:
    path = path if path.startswith("/") else f"/{path}"
    timeout = app_http_timeout()
    payload = json.dumps(body).encode("utf-8")
    last_err: Exception | None = None
    for base in _messaging_http_bases():
        url = base.rstrip("/") + path
        req = Request(
            url,
            data=payload,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method="POST",
        )
        for attempt in range(2):
            try:
                with urlopen(req, timeout=timeout) as resp:
                    raw = resp.read().decode("utf-8", errors="replace")
                data = json.loads(raw) if raw else {}
                if isinstance(data, dict) and data.get("ok"):
                    return data
                last_err = RuntimeError(
                    str(data.get("detail") or data.get("error") or "App server rejected message")
                )
                break
            except HTTPError as exc:
                try:
                    raw = exc.read().decode("utf-8", errors="replace")
                    parsed = json.loads(raw) if raw else {}
                    if isinstance(parsed, dict) and (parsed.get("error") or parsed.get("detail")):
                        last_err = RuntimeError(str(parsed.get("detail") or parsed.get("error")))
                        break
                except Exception:
                    pass
                last_err = RuntimeError(f"App server HTTP {exc.code} at {base}")
                break
            except (URLError, TimeoutError, ValueError, OSError) as exc:
                reason = str(getattr(exc, "reason", exc)).lower()
                if attempt == 0 and ("timed out" in reason or "timeout" in reason):
                    continue
                last_err = exc
                break
    if last_err:
        raise last_err
    raise RuntimeError("No app server reachable for messaging (port 8080).")


def send_shared_message(
    *,
    role: str,
    phone: str,
    sender_name: str,
    recipient_role: str,
    recipient_phone: str,
    recipient_name: str,
    subject: str,
    body: str,
    category: str,
    farmer_id: int | None,
) -> dict:
    """
    Insert admin/farmer message — HTTP first (port 8080), then MySQL with LAN fallbacks.
    Returns { id, ... } for the saved row.
    """
    http_err: Exception | None = None
    mysql_err: Exception | None = None

    if role == "admin" and _messaging_http_bases():
        try:
            data = _http_post_json(
                "/api/admin_send_message.php",
                {
                    "sender_phone": phone,
                    "sender_name": sender_name,
                    "recipient_phone": recipient_phone,
                    "recipient_name": recipient_name,
                    "subject": subject,
                    "body": body,
                    "category": category[:30],
                    "farmer_id": farmer_id,
                },
            )
            msg = data.get("message")
            if isinstance(msg, dict) and msg.get("id"):
                return msg
            mid = data.get("message_id")
            if mid:
                return {"id": int(mid), "body": body, "sender_name": sender_name}
        except Exception as e:
            http_err = e

    if app_db_params():
        conn = None
        try:
            conn = connect_messaging_mysql()
            with conn.cursor() as cur:
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
                        role,
                        phone,
                        sender_name,
                        recipient_role,
                        recipient_phone,
                        recipient_name,
                        subject,
                        body,
                        category[:30],
                        farmer_id,
                    ),
                )
                mid = int(cur.lastrowid)
            try:
                conn.commit()
            except Exception:
                pass
            return {"id": mid, "body": body, "sender_name": sender_name}
        except Exception as e:
            mysql_err = e
        finally:
            if conn:
                conn.close()

    raise MessagesLoadError(mysql_error=mysql_err, http_error=http_err)


def _farmer_user_ids_from_app_server() -> list[int]:
    bases = iter_app_server_bases()
    if not bases:
        return list(range(1, 51))
    data = None
    for base in bases:
        try:
            data = _http_get_json(f"{base}/api/admin_farmer_data.php")
            break
        except Exception:
            continue
    if data is None:
        return list(range(1, 51))
    items = data.get("items")
    if not isinstance(items, list):
        return list(range(1, 51))
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
    return sorted(set(ids)) if ids else list(range(1, 51))


def _is_announcement(m: dict) -> bool:
    return str(m.get("category") or "").lower() == "announcement"


def _count_unread_admin(items: list[dict]) -> int:
    n = 0
    for m in items:
        if _is_announcement(m):
            continue
        if str(m.get("sender_role") or "").lower() != "farmer":
            continue
        if str(m.get("recipient_role") or "").lower() != "admin":
            continue
        if m.get("is_read") in (True, 1, "1"):
            continue
        if m.get("is_archived") in (True, 1, "1"):
            continue
        n += 1
    return n


def _apply_search(items: list[dict], search: str) -> list[dict]:
    if not search:
        return items
    s = search.lower()
    return [
        m
        for m in items
        if s in (str(m.get("subject") or "").lower())
        or s in (str(m.get("body") or "").lower())
        or s in (str(m.get("sender_name") or "").lower())
        or s in (str(m.get("recipient_name") or "").lower())
        or s in (str(m.get("sender_phone") or "").lower())
        or s in (str(m.get("recipient_phone") or "").lower())
    ]


def _apply_folder_filter(items: list[dict], *, folder: str, role: str, phone: str) -> list[dict]:
    folder = (folder or "all").lower()
    out: list[dict] = []
    for m in items:
        if _is_announcement(m):
            continue
        sr = str(m.get("sender_role") or "").lower()
        rr = str(m.get("recipient_role") or "").lower()
        sp = str(m.get("sender_phone") or "")
        rp = str(m.get("recipient_phone") or "")
        archived = m.get("is_archived") in (True, 1, "1")
        starred = m.get("is_starred") in (True, 1, "1")

        if folder == "all":
            out.append(m)
        elif folder == "inbox":
            if role == "admin" and rr == "admin" and (not rp or _phone_matches(rp, phone)) and not archived:
                out.append(m)
            elif role == "farmer" and rr == "farmer" and _phone_matches(rp, phone) and not archived:
                out.append(m)
        elif folder == "sent":
            if sr == role and _phone_matches(sp, phone):
                out.append(m)
        elif folder == "starred" and starred:
            if role == "admin" and (
                (rr == "admin" and (not rp or _phone_matches(rp, phone)))
                or (sr == "admin" and _phone_matches(sp, phone))
            ):
                out.append(m)
            elif role == "farmer" and (
                (rr == "farmer" and _phone_matches(rp, phone))
                or (sr == "farmer" and _phone_matches(sp, phone))
            ):
                out.append(m)
        elif folder == "archived" and archived:
            if role == "admin" and rr == "admin" and (not rp or _phone_matches(rp, phone)):
                out.append(m)
            elif role == "farmer" and rr == "farmer" and _phone_matches(rp, phone):
                out.append(m)
        else:
            if role == "admin" and rr == "admin" and (not rp or _phone_matches(rp, phone)) and not archived:
                out.append(m)
            elif role == "farmer" and rr == "farmer" and _phone_matches(rp, phone) and not archived:
                out.append(m)
    return out


def _apply_category(items: list[dict], category: str) -> list[dict]:
    if not category:
        return items
    c = category.lower()
    return [m for m in items if str(m.get("category") or "").lower() == c]


def _sort_messages(items: list[dict]) -> list[dict]:
    return sorted(
        items,
        key=lambda m: (str(m.get("created_at") or ""), int(m.get("id") or 0)),
        reverse=True,
    )


def _list_from_chat_thread_aggregate(
    *,
    folder: str,
    search: str,
    category: str,
    limit: int,
    role: str,
    phone: str,
) -> tuple[list[dict], int]:
    bases = iter_app_server_bases()
    if not bases:
        raise RuntimeError("app_server_base not set in settings.json")
    base = bases[0]

    by_id: dict[int, dict] = {}
    enough = max(limit * 3, 100)
    for uid in _farmer_user_ids_from_app_server():
        if len(by_id) >= enough:
            break
        try:
            data = _http_get_json(f"{base}/api/chat_thread.php?user_id={int(uid)}")
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError, OSError):
            continue
        if not data.get("ok"):
            continue
        thread_items = data.get("items")
        if not isinstance(thread_items, list):
            continue
        for row in thread_items:
            if not isinstance(row, dict):
                continue
            mid = row.get("id")
            if mid is None:
                continue
            try:
                by_id[int(mid)] = _normalize_shared_message_row(row)
            except (TypeError, ValueError):
                continue

    all_items = list(by_id.values())
    filtered = _apply_folder_filter(all_items, folder=folder, role=role, phone=phone)
    filtered = _apply_category(filtered, category)
    filtered = _apply_search(filtered, search)
    unread = _count_unread_admin(all_items)
    return _sort_messages(filtered)[:limit], unread


def _list_from_admin_shared_messages_php(
    *,
    folder: str,
    search: str,
    category: str,
    limit: int,
    role: str,
    phone: str,
) -> tuple[list[dict], int]:
    bases = iter_app_server_bases()
    if not bases:
        raise RuntimeError("app_server_base not set in settings.json")
    query = urlencode(
        {
            "folder": folder or "all",
            "limit": str(limit),
            "search": search or "",
            "category": category or "",
            "role": role or "",
            "phone": phone or "",
        }
    )
    data = None
    last_err: str | None = None
    for base in bases:
        try:
            data = _http_get_json(f"{base}/api/admin_shared_messages.php?{query}")
            if data.get("ok"):
                break
            last_err = str(data.get("detail") or data.get("error") or "HTTP load failed")
            data = None
        except Exception as exc:
            last_err = str(exc)
            data = None
            continue
    if data is None:
        raise RuntimeError(last_err or "HTTP load failed")
    if not data.get("ok"):
        raise RuntimeError(str(data.get("detail") or data.get("error") or "HTTP load failed"))
    items = data.get("items")
    if not isinstance(items, list):
        items = []
    unread = int(data.get("unread_count") or 0)
    return [_normalize_shared_message_row(m) for m in items if isinstance(m, dict)], unread


def _prefer_http_for_messaging() -> bool:
    """Remote admin laptops often reach :8080 before MySQL :3306."""
    params = app_db_params()
    if not params:
        return bool(_messaging_http_bases() or iter_app_server_bases())
    host = str(params.get("host") or "").strip()
    if is_loopback_host(host):
        return False
    return bool(_messaging_http_bases() or app_server_base())


def _list_from_app_server(
    *,
    folder: str,
    search: str,
    category: str,
    limit: int,
    role: str,
    phone: str,
) -> tuple[list[dict], int]:
    """HTTP load via admin_shared_messages.php (one request — no per-farmer fan-out)."""
    return _list_from_admin_shared_messages_php(
        folder=folder,
        search=search,
        category=category,
        limit=limit,
        role=role,
        phone=phone,
    )


def _build_folder_where(folder: str, role: str, phone: str) -> tuple[str, list]:
    where: list[str] = ["LOWER(category) <> 'announcement'"]
    args: list = []
    if folder == "all":
        where.append(
            "(sender_role = 'farmer' OR recipient_role = 'farmer' "
            "OR sender_role = 'admin' OR recipient_role = 'admin')"
        )
        return " AND ".join(where), args
    if folder == "inbox":
        if role == "admin":
            where.append(
                "recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s) AND is_archived=0"
            )
            args.append(phone)
        else:
            where.append("recipient_role='farmer' AND recipient_phone=%s AND is_archived=0")
            args.append(phone)
    elif folder == "sent":
        where.append("sender_role=%s AND sender_phone=%s")
        args.extend([role, phone])
    elif folder == "starred":
        if role == "admin":
            where.append(
                "((recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s)) "
                "OR (sender_role='admin' AND sender_phone=%s)) AND is_starred=1"
            )
            args.extend([phone, phone])
        else:
            where.append(
                "((recipient_role='farmer' AND recipient_phone=%s) "
                "OR (sender_role='farmer' AND sender_phone=%s)) AND is_starred=1"
            )
            args.extend([phone, phone])
    elif folder == "archived":
        if role == "admin":
            where.append(
                "recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s) AND is_archived=1"
            )
            args.append(phone)
        else:
            where.append("recipient_role='farmer' AND recipient_phone=%s AND is_archived=1")
            args.append(phone)
    else:
        if role == "admin":
            where.append(
                "recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s) AND is_archived=0"
            )
            args.append(phone)
        else:
            where.append("recipient_role='farmer' AND recipient_phone=%s AND is_archived=0")
            args.append(phone)
    return " AND ".join(where), args


def _unread_count_mysql(cur, role: str, phone: str) -> int:
    if role == "admin":
        cur.execute(
            """
            SELECT COUNT(*) AS c FROM shared_messages
            WHERE recipient_role='admin'
              AND (recipient_phone='' OR recipient_phone=%s)
              AND sender_role='farmer' AND is_read=0 AND is_archived=0
              AND LOWER(category) <> 'announcement'
            """,
            (phone,),
        )
    else:
        cur.execute(
            """
            SELECT COUNT(*) AS c FROM shared_messages
            WHERE recipient_role='farmer' AND recipient_phone=%s
              AND is_read=0 AND is_archived=0
              AND LOWER(category) <> 'announcement'
            """,
            (phone,),
        )
    return int((cur.fetchone() or {}).get("c") or 0)


def _list_from_mysql(
    *,
    folder: str,
    search: str,
    category: str,
    limit: int,
    role: str,
    phone: str,
) -> tuple[list[dict], int]:
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set in settings.json")
    conn = connect_messaging_mysql()
    try:
        _ensure_shared_messages_table(conn)
        with conn.cursor() as cur:
            where_sql, args = _build_folder_where(folder, role, phone)
            if category:
                where_sql += " AND category=%s"
                args.append(category)
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
            if search:
                items = _apply_search(items, search)
            unread = _unread_count_mysql(cur, role, phone)
            return items, unread
    finally:
        conn.close()


def _thread_from_admin_shared_messages_http(farmer_phone: str) -> list[dict]:
    """One HTTP call — filter by phone (avoids N× chat_thread.php per farmer)."""
    phone = str(farmer_phone or "").strip()
    if not phone:
        return []
    query = urlencode(
        {
            "folder": "all",
            "limit": "500",
            "search": "",
            "category": "",
            "role": "admin",
            "phone": "",
        }
    )
    for base in _messaging_http_bases():
        try:
            data = _http_get_json(f"{base}/api/admin_shared_messages.php?{query}")
            if not data.get("ok"):
                continue
            items = data.get("items") or []
            rows = [
                _normalize_shared_message_row(m)
                for m in items
                if isinstance(m, dict)
                and not _is_announcement(m)
                and (
                    _phone_matches(str(m.get("sender_phone") or ""), phone)
                    or _phone_matches(str(m.get("recipient_phone") or ""), phone)
                )
            ]
            if rows:
                return sorted(
                    rows,
                    key=lambda m: (str(m.get("created_at") or ""), int(m.get("id") or 0)),
                )
        except Exception:
            continue
    return []


def load_shared_messages_thread(farmer_phone: str) -> list[dict]:
    phone = str(farmer_phone or "").strip()
    if not phone:
        return []

    if _prefer_http_for_messaging() and _messaging_http_bases():
        rows = _thread_from_admin_shared_messages_http(phone)
        if rows:
            return rows

    if app_db_params():
        variants: list[str] = []
        d = re.sub(r"\D", "", phone)
        if phone.strip():
            variants.append(phone.strip())
        if d:
            variants.extend([d, f"+{d}"])
            if d.startswith("63") and len(d) >= 12:
                variants.append("0" + d[2:])
            elif d.startswith("0") and len(d) >= 11:
                variants.append("+63" + d[1:])
        variants = list(dict.fromkeys(v for v in variants if v))
        if variants:
            conn = None
            try:
                conn = connect_messaging_mysql()
                ph = ", ".join(["%s"] * len(variants))
                with conn.cursor() as cur:
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
                    rows = [_normalize_shared_message_row(m) for m in (cur.fetchall() or [])]
                    if rows:
                        return rows
            except Exception:
                pass
            finally:
                if conn:
                    conn.close()

    return _thread_from_admin_shared_messages_http(phone)


def load_unread_message_count(*, role: str, phone: str) -> int:
    """Lightweight unread count for header badge — avoids loading full message lists."""
    if _prefer_http_for_messaging() and (_messaging_http_bases() or app_server_base()):
        try:
            _items, unread = _list_from_app_server(
                folder="inbox",
                search="",
                category="",
                limit=1,
                role=role,
                phone=phone,
            )
            return unread
        except Exception:
            pass

    if app_db_params():
        conn = None
        try:
            conn = connect_messaging_mysql()
            with conn.cursor() as cur:
                return _unread_count_mysql(cur, role, phone)
        except Exception:
            pass
        finally:
            if conn:
                conn.close()

    if app_server_base() and not _prefer_http_for_messaging():
        try:
            _items, unread = _list_from_app_server(
                folder="inbox",
                search="",
                category="",
                limit=1,
                role=role,
                phone=phone,
            )
            return unread
        except Exception:
            pass
    return 0


def load_shared_messages(
    *,
    folder: str,
    search: str = "",
    category: str = "",
    limit: int = 100,
    role: str,
    phone: str,
) -> tuple[list[dict], int, str]:
    limit = clamp_limit(limit, default=100, maximum=500)
    mysql_err: BaseException | None = None
    http_err: BaseException | None = None

    def _try_mysql() -> tuple[list[dict], int] | None:
        if not app_db_params():
            return None
        try:
            return _list_from_mysql(
                folder=folder,
                search=search,
                category=category,
                limit=limit,
                role=role,
                phone=phone,
            )
        except Exception as exc:
            nonlocal mysql_err
            mysql_err = exc
            return None

    def _try_http() -> tuple[list[dict], int] | None:
        if not (app_server_base() or _messaging_http_bases()):
            return None
        try:
            return _list_from_app_server(
                folder=folder,
                search=search,
                category=category,
                limit=limit,
                role=role,
                phone=phone,
            )
        except Exception as exc:
            nonlocal http_err
            http_err = exc
            return None

    if _prefer_http_for_messaging():
        http_result = _try_http()
        if http_result is not None:
            items, unread = http_result
            return items, unread, "http"
        mysql_result = _try_mysql()
        if mysql_result is not None:
            items, unread = mysql_result
            return items, unread, "mysql"
    else:
        mysql_result = _try_mysql()
        if mysql_result is not None:
            items, unread = mysql_result
            return items, unread, "mysql"
        http_result = _try_http()
        if http_result is not None:
            items, unread = http_result
            return items, unread, "http"

    if mysql_err or http_err:
        raise MessagesLoadError(mysql_error=mysql_err, http_error=http_err)
    raise RuntimeError("Configure app_db_host or app_server_base in settings.json")
