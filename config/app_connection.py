"""
Shared Beanthentic-App connection settings and user-safe load error messages.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError

from pymysql.cursors import DictCursor
from pymysql.err import OperationalError, ProgrammingError

_SETTINGS_PATH = Path(__file__).resolve().parents[1] / "settings.json"

GI_UPLOAD_STATUSES = frozenset({"pending", "approved", "archived", "rejected"})


def read_connection_settings() -> dict:
    try:
        raw = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
        conn = raw.get("connection")
        return conn if isinstance(conn, dict) else {}
    except Exception:
        return {}


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
    if errno in (2003, 2002) or "can't connect" in text or "timed out" in text:
        return (
            f"Cannot reach MySQL at {h}. "
            "Use the LAN IP of the PC running XAMPP, ensure MySQL is started, "
            "and that the admin PC can reach that IP on port 3306."
        )
    if errno == 1049 or "unknown database" in text:
        return f"Database not found on {h}. Check app_db_name in settings.json."
    if "app_db_host not set" in text or "app_db_host is empty" in text:
        return "App database host is not configured. Set app_db_host in settings.json."
    if errno == 1146 or "doesn't exist" in text:
        return "Required app tables are missing. Open the Beanthentic-App database on XAMPP first."
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
        return (
            f"Cannot reach the app server{f' at {b}' if b else ''}. "
            "Set app_server_base to http://<XAMPP-LAN-IP>:8080 in settings.json."
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
