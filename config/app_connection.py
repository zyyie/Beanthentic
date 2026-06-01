"""
Shared Beanthentic-App connection settings and user-safe load error messages.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse

from pymysql.cursors import DictCursor
from pymysql.err import OperationalError, ProgrammingError

_SETTINGS_PATH = Path(__file__).resolve().parents[1] / "settings.json"

GI_UPLOAD_STATUSES = frozenset({"pending", "approved", "archived", "rejected"})

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def read_connection_settings() -> dict:
    try:
        raw = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
        conn = raw.get("connection")
        return conn if isinstance(conn, dict) else {}
    except Exception:
        return {}


def _read_settings_root() -> dict:
    try:
        raw = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def is_loopback_host(host: str) -> bool:
    return (host or "").strip().lower() in _LOOPBACK_HOSTS


def _host_from_url(url: str) -> str | None:
    raw = (url or "").strip()
    if not raw:
        return None
    try:
        parsed = urlparse(raw if "://" in raw else f"http://{raw}")
        host = (parsed.hostname or "").strip()
        return host if host and not is_loopback_host(host) else None
    except Exception:
        return None


def lan_fallback_hosts(*, include_request_host: bool = True) -> list[str]:
    """
    Infer XAMPP / app-server LAN IPs from settings (read-only) and optionally the HTTP request.

    Used when connection.app_db_host or app_server_base still say 127.0.0.1 but admin is
    opened from another device on the Wi‑Fi (Host: 192.168.x.x) or XAMPP runs on the phone/PC
    listed under sms.public_base_url / sms_gateway.local_base_url.

    For MySQL, pass include_request_host=False — request Host is usually the admin laptop,
    not the XAMPP machine, and causes long connect timeouts when retried as a DB host.
    """
    seen: set[str] = set()
    out: list[str] = []

    def add(host: str | None) -> None:
        h = (host or "").strip()
        if not h or is_loopback_host(h) or h in seen:
            return
        seen.add(h)
        out.append(h)

    if include_request_host:
        try:
            from flask import has_request_context, request

            if has_request_context():
                add((request.host or "").split(":")[0])
        except Exception:
            pass

    root = _read_settings_root()
    sms = root.get("sms") if isinstance(root.get("sms"), dict) else {}
    add(_host_from_url(str(sms.get("public_base_url") or "")))
    gw = sms.get("sms_gateway") if isinstance(sms.get("sms_gateway"), dict) else {}
    add(_host_from_url(str(gw.get("local_base_url") or "")))

    return out


def lan_mysql_fallback_hosts() -> list[str]:
    """LAN hosts that may run XAMPP MySQL — never the admin Flask request Host."""
    return lan_fallback_hosts(include_request_host=False)


def iter_app_server_bases() -> list[str]:
    """Primary app_server_base plus LAN alternates when settings still use localhost."""
    primary = app_server_base()
    bases: list[str] = []
    seen: set[str] = set()

    def add(base: str | None) -> None:
        b = (base or "").strip().rstrip("/")
        if not b or b in seen:
            return
        seen.add(b)
        bases.append(b)

    add(primary)

    root = _read_settings_root()
    sms = root.get("sms") if isinstance(root.get("sms"), dict) else {}
    gw = sms.get("sms_gateway") if isinstance(sms.get("sms_gateway"), dict) else {}
    add(str(gw.get("local_base_url") or "").strip().rstrip("/"))

    if primary:
        try:
            parsed = urlparse(primary if "://" in primary else f"http://{primary}")
            scheme = parsed.scheme or "http"
            port = parsed.port or 8080
            if is_loopback_host(parsed.hostname or ""):
                for host in lan_fallback_hosts():
                    add(f"{scheme}://{host}:{port}")
        except Exception:
            pass

    return bases


def app_db_params() -> dict | None:
    cfg = read_connection_settings()
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


def app_server_base() -> str:
    base = os.getenv("BEANTHENTIC_APP_SERVER_BASE", "").strip()
    if base:
        return base.rstrip("/")
    cfg = read_connection_settings()
    return str(cfg.get("app_server_base") or "").strip().rstrip("/")


def app_db_connect_timeout(default: int = 8) -> int:
    """
    Seconds to wait for MySQL on the XAMPP device (slow Wi‑Fi / LAN).
    Override: BEANTHENTIC_APP_DB_CONNECT_TIMEOUT (5–120).
    """
    raw = os.getenv("BEANTHENTIC_APP_DB_CONNECT_TIMEOUT", "").strip()
    if not raw:
        return default
    try:
        return max(5, min(120, int(raw)))
    except ValueError:
        return default


def app_http_timeout(default: float = 12) -> float:
    """
    Seconds to wait for Beanthentic-App HTTP API (:8080) responses.
    Override: BEANTHENTIC_APP_HTTP_TIMEOUT (5–120).
    """
    raw = os.getenv("BEANTHENTIC_APP_HTTP_TIMEOUT", "").strip()
    if not raw:
        return default
    try:
        return max(5.0, min(120.0, float(raw)))
    except ValueError:
        return default


def clamp_limit(value, default: int = 500, minimum: int = 1, maximum: int = 800) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = default
    return max(minimum, min(n, maximum))


def _mysql_errno(exc: BaseException) -> int | None:
    if isinstance(exc, (OperationalError, ProgrammingError)) and exc.args:
        try:
            return int(exc.args[0])
        except (TypeError, ValueError):
            return None
    return None


def friendly_mysql_error(exc: BaseException, host: str | None = None) -> str:
    cfg = read_connection_settings()
    h = (host or str(cfg.get("app_db_host") or "")).strip() or "the app database host"
    errno = _mysql_errno(exc)
    text = str(exc).lower()

    if errno == 1045 or "access denied" in text:
        return (
            f"MySQL login failed for {h}. "
            "Set the correct app_db_user and app_db_pass in settings.json "
            "(Admin Connection Settings or Beanthentic/settings.json)."
        )
    if errno == 1130 or "is not allowed to connect" in text:
        return (
            f"MySQL on {h} rejected this PC. Use 127.0.0.1 in settings.json if XAMPP runs on this "
            "same computer, or run xampp-enable-lan-mysql.sql on the XAMPP device to allow remote access."
        )
    if errno in (2003, 2002) or "can't connect" in text or "timed out" in text:
        fallbacks = lan_fallback_hosts()
        extra = ""
        if fallbacks:
            extra = (
                f" Tried LAN fallbacks: {', '.join(fallbacks[:3])}. "
                "Ensure XAMPP MySQL is running on that device."
            )
        return (
            f"Cannot reach MySQL at {h}. "
            "Use the LAN IP of the PC running XAMPP, ensure MySQL is started, "
            "and that the admin PC can reach that IP on port 3306."
            f"{extra}"
        )
    if errno == 1049 or "unknown database" in text:
        return f"Database not found on {h}. Check app_db_name in settings.json."
    if "app_db_host not set" in text or "app_db_host is empty" in text:
        return "App database host is not configured. Set app_db_host in settings.json."
    if errno in (1054, 1146) or "unknown column" in text or "doesn't exist" in text:
        return "Required app tables or columns are missing. Open the Beanthentic-App database on XAMPP first."
    return f"Could not read from the app database ({h}). Check connection settings and MySQL status."


def friendly_http_error(exc: BaseException, base: str | None = None) -> str:
    b = (base or app_server_base() or "").strip()
    if isinstance(exc, HTTPError):
        if exc.code == 404:
            return (
                "App server API not found (HTTP 404). "
                "Run python app.py on the XAMPP device and set app_server_base in settings.json."
            )
        if exc.code in (401, 403):
            return "App server rejected the request. Check app_server_base and server access."
        return f"App server returned HTTP {exc.code}. Check app_server_base{f' ({b})' if b else ''}."
    if isinstance(exc, URLError):
        reason = getattr(exc, "reason", None)
        if reason and "timed out" in str(reason).lower():
            return (
                f"App server timed out{f' at {b}' if b else ''}. "
                "Confirm the device is on the network and python app.py is running on port 8080."
            )
        tried = iter_app_server_bases()
        extra = ""
        if len(tried) > 1:
            extra = f" Also tried: {', '.join(tried[1:4])}."
        return (
            f"Cannot reach the app server{f' at {b}' if b else ''}. "
            "Run python app.py (or XAMPP) on the Beanthentic-App device at port 8080."
            f"{extra}"
        )
    text = str(exc).lower()
    if "app_server_base not set" in text:
        return "App server URL is not configured. Set app_server_base in settings.json."
    return "Could not load data from the app server. Check app_server_base and that the app is running."


def friendly_load_failure(
    *,
    module_label: str,
    mysql_error: BaseException | None = None,
    http_error: BaseException | None = None,
) -> str:
    if mysql_error and http_error:
        return (
            f"Could not load {module_label}. "
            f"{friendly_mysql_error(mysql_error)} "
            f"Also: {friendly_http_error(http_error)}"
        )
    if mysql_error:
        return f"Could not load {module_label}. {friendly_mysql_error(mysql_error)}"
    if http_error:
        return f"Could not load {module_label}. {friendly_http_error(http_error)}"
    return f"Could not load {module_label}. Check connection settings in settings.json."


def load_error_payload(module_code: str, message: str, hint: str | None = None) -> dict:
    cfg = read_connection_settings()
    default_hint = (
        "Open /connection-settings or edit Beanthentic/settings.json - "
        f"app_db_host={cfg.get('app_db_host') or '(not set)'}, "
        f"app_server_base={cfg.get('app_server_base') or '(not set)'}."
    )
    return {
        "ok": False,
        "error": module_code,
        "message": message,
        "detail": message,
        "hint": hint or default_hint,
        "items": [],
    }
