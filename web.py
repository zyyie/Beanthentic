"""
Beanthentic - Coffee Farmer Management System

A Flask-based web application for managing coffee farmer records,
including farmer registration, production tracking, IPOPHL document
analysis, and administrative functions.
"""

import json
import os
import re
from pathlib import Path

from flask import Flask, jsonify, redirect, request, make_response
from sqlalchemy import text

from config.app_connection import app_db_connect_timeout

from config.auth import register_auth_routes
from config.security import configure_app_security, require_admin, safe_error_message
from config.validation import (
    validate_db_host,
    validate_db_name,
    validate_db_port,
)
from config.models import db
from api.export_api import register_export_routes
from api.farmer_api import register_farmer_routes
from api.transactions_api import register_transactions_routes
from api.client_reports_api import register_client_reports_routes
from api.gi_contributions_api import register_gi_contributions_routes
from api.ipophl_api import register_ipophl_routes
from api.misconduct_report_api import register_misconduct_report_routes
from api.messaging_api import register_messaging_routes
from api.platform_api import register_platform_routes
from api.ml_api import register_ml_routes
from routes.dashboard import register_dashboard_routes
from routes.farmer_portal import register_farmer_portal_routes

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = os.getenv("FLASK_SECRET_KEY", os.getenv("SECRET_KEY", "beanthentic-dev-secret-change-this"))
configure_app_security(app)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0


@app.after_request
def _add_cors_for_lan_api(response):
    """Allow Beanthentic-App / phones on the same Wi‑Fi to call admin JSON APIs."""
    try:
        path = request.path or ""
    except RuntimeError:
        return response
    if path.startswith("/api/") or path in ("/health", "/api/connection-status"):
        origin = (request.headers.get("Origin") or "").strip()
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        else:
            response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = (
            "Content-Type, Authorization, Accept, X-HTTP-Method-Override, X-Beanthentic-Client-Host"
        )
        response.headers["Access-Control-Max-Age"] = "86400"
    return response


@app.route("/api/connection-status", methods=["GET", "OPTIONS"])
def api_connection_status():
    """
    Public LAN diagnostic — no admin login required.
    Use from browser on admin PC or phone: http://<admin-LAN-IP>:5000/api/connection-status
    """
    if request.method == "OPTIONS":
        return make_response("", 204)

    from api.gi_contributions_api import probe_app_mysql, probe_gi_app_server
    from config.app_connection import (
        app_db_params,
        app_server_base,
        guess_lan_ip,
        iter_app_server_bases,
        read_connection_settings,
    )

    conn = read_connection_settings()
    mysql_ok, mysql_err = probe_app_mysql(timeout=4.0)
    http_ok, http_base, http_err = probe_gi_app_server(timeout=4.0)
    admin_lan = guess_lan_ip()
    bases = iter_app_server_bases()
    payload = {
        "ok": bool(http_ok or mysql_ok),
        "admin_lan_ip": admin_lan or None,
        "admin_port": int(os.getenv("PORT", "5000")),
        "connection": conn,
        "app_server_bases_tried": bases,
        "mysql_reachable": mysql_ok,
        "mysql_error": None if mysql_ok else mysql_err,
        "http_reachable": http_ok,
        "http_base": http_base or None,
        "http_error": None if http_ok else http_err,
        "app_server_base": app_server_base() or None,
        "hint": (
            "Beanthentic-App (phone) must use the SAME host as app_server_base on port 8080 — "
            "not this admin port 5000. In the app: Server URL → http://<XAMPP-PC-IP>:8080"
        ),
    }
    code = 200 if payload["ok"] else 503
    return jsonify(payload), code

SETTINGS_PATH = Path(__file__).resolve().parent / "settings.json"


def _repair_cross_device_settings() -> None:
    """Fix loopback / :5000 mistakes in settings.json when web.py runs on another PC."""
    try:
        from config.app_connection import repair_settings_on_disk

        notes = repair_settings_on_disk(SETTINGS_PATH)
        for line in notes:
            print(f"[Beanthentic] Connection repair: {line}")
    except Exception as exc:
        print(f"[Beanthentic] Connection repair skipped: {exc}")


_repair_cross_device_settings()


def _read_settings() -> dict:
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _read_connection_settings() -> dict:
    settings = _read_settings()
    conn = settings.get("connection")
    return conn if isinstance(conn, dict) else {}


def _write_connection_settings(payload: dict) -> None:
    settings = _read_settings()
    settings["connection"] = payload
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def _write_sms_settings(payload: dict) -> None:
    from config.sms import _normalize_cloud_url, _normalize_local_base_url

    sms = dict(payload) if isinstance(payload, dict) else {}
    gw = sms.get("sms_gateway")
    if isinstance(gw, dict):
        gw = dict(gw)
        if gw.get("local_base_url"):
            gw["local_base_url"] = _normalize_local_base_url(str(gw["local_base_url"]))
        gw["cloud_url"] = _normalize_cloud_url(str(gw.get("cloud_url") or ""))
        sms["sms_gateway"] = gw
    settings = _read_settings()
    settings["sms"] = sms
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def _mysql_url_from_connection(conn: dict) -> str:
    """Build SQLAlchemy MySQL URL from settings.json connection block."""
    host = str(conn.get("app_db_host") or "").strip()
    user = str(conn.get("app_db_user") or "root").strip() or "root"
    password = str(conn.get("app_db_pass") if conn.get("app_db_pass") is not None else "")
    db_name = str(conn.get("app_db_name") or "beanthentic_app").strip() or "beanthentic_app"
    port_raw = conn.get("app_db_port", 3306)
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        port = 3306
    if not host:
        return ""
    port_part = f":{port}" if port else ""
    return f"mysql+pymysql://{user}:{password}@{host}{port_part}/{db_name}"


# SQLAlchemy configuration
# Priority:
# 1) DATABASE_URL env var (full SQLAlchemy URL)
# 2) MySQL from Beanthentic/settings.json (XAMPP — same as connection-settings UI)
# 3) MySQL from env vars (MYSQL_USER/MYSQL_PASSWORD/MYSQL_HOST/MYSQL_DB)
database_url = os.getenv("DATABASE_URL", "").strip()
if not database_url:
    database_url = _mysql_url_from_connection(_read_connection_settings())
if not database_url:
    mysql_user = os.getenv("MYSQL_USER", "").strip()
    mysql_password = os.getenv("MYSQL_PASSWORD", "")
    mysql_host = os.getenv("MYSQL_HOST", "").strip()
    mysql_db = os.getenv("MYSQL_DB", "").strip()
    mysql_port = os.getenv("MYSQL_PORT", "").strip()

    if mysql_user and mysql_host and mysql_db:
        port_part = f":{mysql_port}" if mysql_port else ""
        database_url = f"mysql+pymysql://{mysql_user}:{mysql_password}@{mysql_host}{port_part}/{mysql_db}"

if not database_url:
    raise RuntimeError(
        "No database configured. Set MySQL in Beanthentic/settings.json "
        "(connection.app_db_host, app_db_user, app_db_name) or DATABASE_URL."
    )

app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_pre_ping": True,
    "connect_args": {"connect_timeout": app_db_connect_timeout(8)},
}

# Initialize database
db.init_app(app)


def _uses_xampp_app_database() -> bool:
    """True when connected to Beanthentic-App XAMPP schema (not legacy admin SQLite tables)."""
    uri = str(app.config.get("SQLALCHEMY_DATABASE_URI") or "").lower()
    if "beanthentic_app" in uri:
        return True
    return bool(str(_read_connection_settings().get("app_db_host") or "").strip())


def _init_database_schema() -> None:
    """
    XAMPP beanthentic_app already defines farmers, affiliation_information, etc.
    db.create_all() would try to add legacy tables (affiliations → farmers.id) and fail.
    Only create admin-web tables that are missing.
    """
    from sqlalchemy import inspect

    from config.models import ActivityLogEntry, AdminUser, DocumentAnalysis

    if _uses_xampp_app_database():
        inspector = inspect(db.engine)
        existing = {t.lower() for t in inspector.get_table_names()}
        for model in (AdminUser, ActivityLogEntry, DocumentAnalysis):
            name = model.__tablename__.lower()
            if name not in existing:
                model.__table__.create(db.engine, checkfirst=True)
        return

    db.create_all()


with app.app_context():
    try:
        _init_database_schema()
    except Exception as e:
        print(f"Warning: Could not create tables: {e}")

# Register all route modules
register_auth_routes(app)

from config.sms import SMS_BUILD_ID, sms_config, send_otp_sms  # noqa: E402

print(f"[Beanthentic] SMS module loaded: {SMS_BUILD_ID}")


def _repair_sms_settings_on_disk() -> None:
    """Normalize SMS Gateway URLs in settings.json (fixes missing https:// on cloud_url)."""
    try:
        settings = _read_settings()
        sms = settings.get("sms")
        if not isinstance(sms, dict):
            return
        gw = sms.get("sms_gateway")
        if not isinstance(gw, dict):
            return
        from config.sms import _normalize_cloud_url, _normalize_local_base_url

        fixed = dict(gw)
        changed = False
        cloud = _normalize_cloud_url(str(gw.get("cloud_url") or ""))
        if cloud != str(gw.get("cloud_url") or "").strip():
            fixed["cloud_url"] = cloud
            changed = True
        local = _normalize_local_base_url(str(gw.get("local_base_url") or ""))
        if local != str(gw.get("local_base_url") or "").strip().rstrip("/"):
            fixed["local_base_url"] = local
            changed = True
        if changed:
            sms = dict(sms)
            sms["sms_gateway"] = fixed
            settings["sms"] = sms
            SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")
            print("[Beanthentic] Repaired SMS URLs in settings.json")
    except Exception as exc:
        print(f"[Beanthentic] SMS settings repair skipped: {exc}")


_repair_sms_settings_on_disk()


@app.route("/api/sms-ping")
def sms_ping():
    """Verify the running server uses the latest SMS code (check sms_build in JSON)."""
    cfg = sms_config()
    from config.sms import _gateway_attempts

    gw = (_read_settings().get("sms") or {}).get("sms_gateway") or {}
    return jsonify(
        {
            "ok": True,
            "sms_build": SMS_BUILD_ID,
            "gateway_mode": cfg.get("gateway_mode"),
            "has_cloud_password": bool(cfg.get("gateway_password")),
            "has_local_password": bool(cfg.get("gateway_local_password")),
            "attempts": [a[0] for a in _gateway_attempts(cfg)],
            "settings_path": str(SETTINGS_PATH),
            "local_base_url": gw.get("local_base_url"),
        }
    )


register_transactions_routes(app)
register_client_reports_routes(app)
register_gi_contributions_routes(app)
register_dashboard_routes(app)
register_farmer_routes(app)
register_export_routes(app)
register_ipophl_routes(app)
register_misconduct_report_routes(app)
register_messaging_routes(app)

# Backup GET /api/messages (same as messaging_api) if an older handler returns 503 without HTTP fallback
from api.messaging_api import _shared_identity  # noqa: E402
from config.app_connection import friendly_load_failure, load_error_payload  # noqa: E402
from config.messaging_load import MessagesLoadError, load_shared_messages  # noqa: E402
from config.utils import is_authenticated, is_farmer_authenticated  # noqa: E402


@app.route("/api/messages", methods=["GET"], endpoint="api_messages_list_backup")
def api_messages_list_backup():
    if not (is_authenticated() or is_farmer_authenticated()):
        return jsonify({"error": "Unauthorized"}), 401
    role, phone, _name = _shared_identity()
    folder = request.args.get("folder", "inbox")
    search = (request.args.get("search", "") or "").strip().lower()
    category = request.args.get("category", "").strip().lower()
    limit = min(int(request.args.get("limit", "100")), 500)
    try:
        items, unread_count, source = load_shared_messages(
            folder=folder,
            search=search,
            category=category,
            limit=limit,
            role=role,
            phone=phone,
        )
        return jsonify({"items": items, "unread_count": unread_count, "source": source, "ok": True})
    except MessagesLoadError as e:
        msg = friendly_load_failure(
            module_label="messages",
            mysql_error=e.mysql_error,
            http_error=e.http_error,
        )
        return jsonify(load_error_payload("MESSAGES_LOAD_FAILED", msg)), 503
    except Exception as e:
        msg = friendly_load_failure(module_label="messages", http_error=e)
        return jsonify(load_error_payload("MESSAGES_LOAD_FAILED", msg)), 503


register_platform_routes(app)
register_ml_routes(app)
register_farmer_portal_routes(app)


def _log_ipophl_ml_readiness() -> None:
    """Log whether document/farmer ML models are loaded (helps diagnose 0% analysis)."""
    try:
        from machinelearning.ai_engine import gi_analyzer

        status = gi_analyzer.ml_status()
        if not status.get("document_model_loaded"):
            app.logger.warning(
                "IPOPHL document ML model not loaded. Install deps and train: "
                "pip install -r config/requirements.txt && "
                "cd machinelearning && python train_ai_model.py --full-pipeline"
            )
        else:
            app.logger.info(
                "IPOPHL AI ready (farmer=%s, document=%s, mode=%s)",
                status.get("farmer_model_loaded"),
                status.get("document_model_loaded"),
                status.get("document_analysis_default"),
            )
    except Exception as exc:
        app.logger.warning("IPOPHL AI engine unavailable: %s", exc)


_log_ipophl_ml_readiness()

# Ensure GI broadcast POST is registered on the app (avoids 405 from static_folder when a module fails to load)
from api.gi_contributions_api import handle_gi_contributions_send  # noqa: E402

for _gi_send_rule in (
    "/api/gi-contributions-send",
    "/api/gi-contributions/send",
    "/api/gi-contributions/broadcast",
):
    app.add_url_rule(
        _gi_send_rule,
        endpoint=f"gi_broadcast_{_gi_send_rule.strip('/').replace('/', '_')}",
        view_func=handle_gi_contributions_send,
        methods=["POST"],
    )


@app.route("/connection-settings", methods=["GET", "POST"])
@require_admin
def connection_settings():
    """Manual UI to set cross-device DB connection IP/port for admin web."""
    form_error = ""
    if request.method == "POST":
        host = (request.form.get("app_db_host") or "").strip()
        port_raw = (request.form.get("app_db_port") or "3306").strip()
        user = (request.form.get("app_db_user") or "root").strip() or "root"
        password_field = request.form.get("app_db_pass")
        db_name = (request.form.get("app_db_name") or "beanthentic_app").strip() or "beanthentic_app"

        ok_host, host_err = validate_db_host(host)
        ok_port, port_err, port = validate_db_port(port_raw)
        ok_db, db_err, db_name = validate_db_name(db_name)
        if not ok_host:
            form_error = host_err
        elif not ok_port:
            form_error = port_err
        elif not ok_db:
            form_error = db_err
        elif not user or len(user) > 64 or not re.match(r"^[\w.\-]+$", user):
            form_error = "Database user must be 1–64 characters (letters, numbers, underscore, dot, hyphen)."
        else:
            from config.app_connection import normalize_app_server_base_url

            server_base = (request.form.get("app_server_base") or "").strip().rstrip("/")
            if server_base and not server_base.startswith(("http://", "https://")):
                form_error = "App server base URL must start with http:// or https://"
            else:
                server_base = normalize_app_server_base_url(server_base, db_host=host)

        sms_enabled = request.form.get("sms_enabled") == "1"
        sms_provider = (request.form.get("sms_provider") or "auto").strip().lower()
        allowed_providers = (
            "auto",
            "sms_gateway",
            "semaphore",
            "twilio",
            "log",
        )
        if sms_provider not in allowed_providers:
            sms_provider = "auto"
        sms_sender = (request.form.get("sms_sender_name") or "Beanthentic").strip()[:11]
        public_base = (request.form.get("public_base_url") or "").strip().rstrip("/")
        if public_base and not public_base.startswith(("http://", "https://")):
            form_error = form_error or "Public base URL must start with http:// or https."

        gw_mode = (request.form.get("gateway_mode") or "auto").strip().lower()
        if gw_mode not in ("local", "cloud", "auto"):
            gw_mode = "auto"
        gw_local = (request.form.get("gateway_local_base_url") or "").strip().rstrip("/")
        if gw_local and not gw_local.startswith(("http://", "https://")):
            gw_local = f"http://{gw_local.lstrip('/')}"
        if gw_local and "sms-gate.app" in gw_local.lower():
            form_error = form_error or (
                "Local base URL must be your phone IP (e.g. http://192.168.x.x:8080), not api.sms-gate.app."
            )
        gw_local_user = (request.form.get("gateway_local_username") or "").strip()
        gw_local_pass = request.form.get("gateway_local_password")
        gw_user = (request.form.get("gateway_username") or "").strip()
        gw_pass = request.form.get("gateway_password")
        try:
            gw_sim = int(request.form.get("gateway_sim_number") or 1)
        except ValueError:
            gw_sim = 1

        if not form_error:
            conn_prev = _read_connection_settings()
            password = (
                conn_prev.get("app_db_pass")
                if password_field is None or password_field == ""
                else password_field
            )
            _write_connection_settings(
                {
                    "app_db_host": host,
                    "app_db_port": port,
                    "app_db_user": user,
                    "app_db_pass": password if password is not None else "",
                    "app_db_name": db_name,
                    "app_server_base": server_base or str(conn_prev.get("app_server_base") or "").strip(),
                }
            )
            sms_prev = _read_settings().get("sms")
            sms_prev = sms_prev if isinstance(sms_prev, dict) else {}
            gw_prev = sms_prev.get("sms_gateway")
            gw_prev = gw_prev if isinstance(gw_prev, dict) else {}
            gw_password = (
                gw_prev.get("password")
                if gw_pass is None or gw_pass == ""
                else gw_pass
            )
            gw_local_password = (
                gw_prev.get("local_password")
                if gw_local_pass is None or gw_local_pass == ""
                else gw_local_pass
            )
            _write_sms_settings(
                {
                    "enabled": sms_enabled,
                    "provider": sms_provider,
                    "sender_name": sms_sender or "Beanthentic",
                    "public_base_url": public_base or str(sms_prev.get("public_base_url") or "").strip(),
                    "sms_gateway": {
                        "mode": gw_mode,
                        "local_base_url": gw_local or str(gw_prev.get("local_base_url") or "").strip(),
                        "local_path": str(gw_prev.get("local_path") or "/message"),
                        "local_username": gw_local_user or str(gw_prev.get("local_username") or "sms").strip(),
                        "local_password": gw_local_password if gw_local_password is not None else "",
                        "cloud_url": (
                            str(gw_prev.get("cloud_url") or "").strip()
                            or "https://api.sms-gate.app/3rdparty/v1/messages"
                        ),
                        "cloud_device_id": str(gw_prev.get("cloud_device_id") or gw_prev.get("device_id") or "").strip(),
                        "username": gw_user or str(gw_prev.get("username") or "").strip(),
                        "password": gw_password if gw_password is not None else "",
                        "sim_number": max(1, min(3, gw_sim)),
                    },
                }
            )
            return redirect("/connection-settings?saved=1")

    from config.app_connection import guess_lan_ip, probe_app_server_http

    conn = _read_connection_settings()
    sms = _read_settings().get("sms")
    sms = sms if isinstance(sms, dict) else {}
    saved = (request.args.get("saved") or "").strip() == "1"
    admin_lan = guess_lan_ip() or "(unknown — check Wi‑Fi)"
    http_ok, http_used, http_err = probe_app_server_http(timeout=4.0)
    probe_line = (
        f"<p class='ok'>App server OK: <code>{http_used}</code></p>"
        if http_ok
        else f"<p style='color:#b91c1c;'>App server not reachable: {http_err}</p>"
    )
    host = str(conn.get("app_db_host") or "")
    port = str(conn.get("app_db_port") or 3306)
    user = str(conn.get("app_db_user") or "root")
    db_name = str(conn.get("app_db_name") or "beanthentic_app")
    server_base = str(conn.get("app_server_base") or "http://192.168.x.x:8080")
    sms_enabled = "checked" if sms.get("enabled", True) else ""
    sms_provider = str(sms.get("provider") or "auto")
    sms_sender = str(sms.get("sender_name") or "Beanthentic")
    public_base = str(sms.get("public_base_url") or "http://127.0.0.1:5000")
    gw = sms.get("sms_gateway") if isinstance(sms.get("sms_gateway"), dict) else {}
    gw_mode = str(gw.get("mode") or "auto")
    gw_local = str(gw.get("local_base_url") or "")
    gw_local_user = str(gw.get("local_username") or "sms")
    gw_user = str(gw.get("username") or "")
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connection Settings</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; max-width: 820px; }}
    h1 {{ margin-bottom: 8px; }}
    p {{ color: #374151; }}
    .ok {{ color: #166534; margin-bottom: 12px; }}
    label {{ display:block; margin-top: 12px; font-weight: 600; }}
    input {{ width: 100%; padding: 8px; box-sizing: border-box; margin-top: 6px; }}
    button {{ margin-top: 16px; padding: 10px 14px; border: 0; background: #14532d; color: #fff; border-radius: 6px; }}
    code {{ background: #f3f4f6; padding: 2px 6px; border-radius: 4px; }}
  </style>
</head>
<body>
  <h1>Admin Web Connection Settings</h1>
  <p>Ilagay dito ang IP ng device na may XAMPP + <code>python app.py</code> (port <strong>8080</strong>) — hindi ang admin port 5000.</p>
  <p>Admin PC LAN IP (web.py): <code>{admin_lan}</code> — buksan <a href="/api/connection-status">/api/connection-status</a> para sa diagnostic.</p>
  <p style="font-size:0.9rem;">Sa phone (Beanthentic-App): Server URL = <code>http://&lt;XAMPP-PC-IP&gt;:8080</code> (pareho sa <code>app_server_base</code> sa baba).</p>
  {"<div class='ok'>Saved. Re-run or refresh dashboard.</div>" if saved else ""}
  {probe_line}
  {f"<div style='color:#b91c1c;margin-bottom:12px;'>{form_error}</div>" if form_error else ""}
  <form method="post">
    <label>App DB Host (IP)</label>
    <input name="app_db_host" value="{host}" placeholder="192.168.x.x" />
    <label>App DB Port</label>
    <input name="app_db_port" value="{port}" placeholder="3306" />
    <label>App DB User</label>
    <input name="app_db_user" value="{user}" placeholder="root" />
    <label>App DB Password</label>
    <input name="app_db_pass" type="password" value="" placeholder="(leave blank if none)" />
    <label>App DB Name</label>
    <input name="app_db_name" value="{db_name}" placeholder="beanthentic_app" />
    <label>App Server Base URL (HTTP fallback)</label>
    <input name="app_server_base" value="{server_base}" placeholder="http://192.168.x.x:8080" />
    <h2 style="margin-top:28px;">SMS (OTP &amp; password reset)</h2>
    <p style="font-size:0.9rem;">Use <strong>SMS Gateway for Android</strong> on a phone on the same Wi‑Fi as this PC.</p>
    <label><input type="checkbox" name="sms_enabled" value="1" {sms_enabled} /> Enable SMS</label>
    <label>SMS provider</label>
    <select name="sms_provider" style="width:100%;padding:8px;margin-top:6px;">
      <option value="sms_gateway" {"selected" if sms_provider in ("sms_gateway", "sms_forwarder", "auto", "") else ""}>SMS Gateway for Android (recommended)</option>
      <option value="auto" {"selected" if sms_provider == "auto" else ""}>auto (Gateway → cloud APIs → log)</option>
      <option value="semaphore" {"selected" if sms_provider == "semaphore" else ""}>Semaphore (cloud API)</option>
      <option value="twilio" {"selected" if sms_provider == "twilio" else ""}>Twilio</option>
      <option value="log" {"selected" if sms_provider == "log" else ""}>log (dev only)</option>
    </select>
    <label>Public base URL (admin reset links in SMS)</label>
    <input name="public_base_url" value="{public_base}" placeholder="http://192.168.x.x:5000" />
    <h3 style="margin-top:20px;">SMS Gateway for Android</h3>
    <p style="font-size:0.85rem;color:#4b5563;">App → Local Server ON. Copy username/password from the app. Default port 8080.</p>
    <label>Gateway mode</label>
    <select name="gateway_mode" style="width:100%;padding:8px;margin-top:6px;">
      <option value="auto" {"selected" if gw_mode == "auto" else ""}>auto (cloud, then local — recommended)</option>
      <option value="cloud" {"selected" if gw_mode == "cloud" else ""}>cloud only (api.sms-gate.app)</option>
      <option value="local" {"selected" if gw_mode == "local" else ""}>local only (phone on Wi‑Fi)</option>
    </select>
    <label>Local base URL (from app → Local address)</label>
    <input name="gateway_local_base_url" value="{gw_local}" placeholder="http://192.168.100.63:8080" />
    <label>Local username (Local Server in app, usually sms)</label>
    <input name="gateway_local_username" value="{gw_local_user}" placeholder="sms" />
    <label>Local password</label>
    <input name="gateway_local_password" type="password" value="" placeholder="(leave blank to keep current)" />
    <label>Cloud username (Cloud Server in app)</label>
    <input name="gateway_username" value="{gw_user}" placeholder="B4U_TR" />
    <label>Cloud password</label>
    <input name="gateway_password" type="password" value="" placeholder="(leave blank to keep current)" />
    <label>SIM number (1–3)</label>
    <input name="gateway_sim_number" value="{gw.get('sim_number', 1)}" placeholder="1" />
    <button type="submit">Save Connection</button>
  </form>
  <p>Config file: <code>Beanthentic/settings.json</code></p>
</body>
</html>"""

# Health check endpoint
@app.route("/health")
def health():
    """
    Health check for monitoring.

    Remote app MySQL (settings.json app_db_host) may be unreachable from the admin PC
    while the admin app, IPOPHL (local JSON), and app HTTP bridge (:8080) still work.
    """
    from config.app_connection import app_db_params, app_server_base, friendly_mysql_error
    from config.ipophl_store import STORE_PATH
    from config.mysql_app_bridge import connect_app_mysql

    from config.sms import SMS_BUILD_ID  # noqa: E402

    payload: dict = {
        "status": "healthy",
        "admin_server": "up",
        "sms_build": SMS_BUILD_ID,
        "database": "disconnected",
        "app_mysql": "not_configured",
        "app_server_http": "not_configured",
        "ipophl_local": "unknown",
    }
    hints: list[str] = []

    params = app_db_params()
    if params:
        payload["app_mysql"] = "disconnected"
        conn = None
        try:
            conn = connect_app_mysql(params)
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            payload["app_mysql"] = "connected"
            payload["database"] = "connected"
        except Exception as e:
            payload["app_mysql_error"] = friendly_mysql_error(e, host=str(params.get("host") or ""))
            hints.append(
                "App MySQL unreachable from this PC. Use Connection Settings: set app_db_host to the "
                "XAMPP PC LAN IP, start MySQL on that device, or use app_server_base HTTP only."
            )
        finally:
            if conn:
                conn.close()
    else:
        hints.append("Set app_db_host in settings.json or /connection-settings for farmer/app data.")

    base = app_server_base()
    if base:
        from config.app_connection import probe_app_server_http

        payload["app_server_http"] = "disconnected"
        payload["app_server_base"] = base
        http_ok, http_used, http_err = probe_app_server_http(timeout=4.0)
        if http_ok:
            payload["app_server_http"] = "connected"
            payload["app_server_http_base"] = http_used
            if payload["database"] != "connected":
                payload["database"] = "http_only"
            try:
                from config.ipophl_app_bridge import _request_bridge

                _request_bridge(action="list", query={"limit": 1}, timeout=4)
                payload["ipophl_http_bridge"] = "connected"
            except Exception as ipophl_exc:
                payload["ipophl_http_bridge"] = "disconnected"
                payload["ipophl_http_bridge_error"] = str(ipophl_exc)
        else:
            payload["app_server_http_error"] = http_err
            hints.append(
                f"Cannot reach app server at {base}. On the XAMPP PC: "
                "pip install -r requirements.txt && python app.py (port 8080). "
                "Allow Windows Firewall inbound TCP 8080 on that PC."
            )

    if STORE_PATH.exists():
        payload["ipophl_local"] = "available"
    else:
        payload["ipophl_local"] = "ready"

    sqlalchemy_ok = False
    try:
        db.session.execute(text("SELECT 1"))
        sqlalchemy_ok = True
        payload["sqlalchemy"] = "connected"
    except Exception as e:
        payload["sqlalchemy"] = "disconnected"
        payload["sqlalchemy_error"] = safe_error_message(e, public="SQLAlchemy ping failed.")

    if payload["app_mysql"] == "connected" or payload["app_server_http"] == "connected":
        payload["status"] = "healthy"
        code = 200
    elif payload["ipophl_local"] in ("available", "ready"):
        payload["status"] = "degraded"
        payload["message"] = (
            "Admin web is running. Remote app database is not reachable; "
            "IPOPHL uploads and local features still work."
        )
        code = 200
    else:
        payload["status"] = "unhealthy"
        payload["message"] = "Admin web is running but no app database path is available."
        code = 503

    if hints:
        payload["hints"] = hints

    return jsonify(payload), code


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    try:
        from config.app_connection import (
            app_server_base,
            guess_lan_ip,
            probe_app_server_http,
            read_connection_settings,
        )

        lan = guess_lan_ip()
        conn = read_connection_settings()
        print("[Beanthentic] Cross-device setup:")
        print(f"  Admin web (this PC): http://{lan or '127.0.0.1'}:{port}")
        print(f"  app_db_host: {conn.get('app_db_host') or '(not set)'}")
        print(f"  app_server_base: {app_server_base() or '(not set)'}")
        http_ok, http_used, http_err = probe_app_server_http(timeout=5.0)
        if http_ok:
            print(f"  Beanthentic-App HTTP: OK @ {http_used}")
        else:
            print(f"  Beanthentic-App HTTP: FAIL — {http_err}")
            print(
                "  Fix: On the XAMPP PC run python app.py, then set app_server_base "
                "in /connection-settings to http://<XAMPP-LAN-IP>:8080"
            )
        print(
            f"  Phone Server URL must match app_server_base (port 8080), not admin :{port}."
        )
        print(f"  Diagnostic: http://{lan or '127.0.0.1'}:{port}/api/connection-status")
    except Exception as boot_exc:
        print(f"[Beanthentic] Startup diagnostic skipped: {boot_exc}")
    app.run(host="0.0.0.0", port=port, debug=debug, threaded=True)
