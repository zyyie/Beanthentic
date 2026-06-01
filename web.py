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

from flask import Flask, jsonify, redirect, request
from sqlalchemy import text

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

SETTINGS_PATH = Path(__file__).resolve().parent / "settings.json"


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
    settings = _read_settings()
    settings["sms"] = payload
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
    "connect_args": {"connect_timeout": 3, "read_timeout": 5, "write_timeout": 5},
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
register_transactions_routes(app)
register_client_reports_routes(app)
register_gi_contributions_routes(app)
register_dashboard_routes(app)
register_farmer_routes(app)
register_export_routes(app)
register_ipophl_routes(app)
register_misconduct_report_routes(app)
register_messaging_routes(app)
register_platform_routes(app)
register_ml_routes(app)
register_farmer_portal_routes(app)


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
            server_base = (request.form.get("app_server_base") or "").strip().rstrip("/")
            if server_base and not server_base.startswith(("http://", "https://")):
                form_error = "App server base URL must start with http:// or https://."

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

        gw_mode = (request.form.get("gateway_mode") or "local").strip().lower()
        if gw_mode not in ("local", "cloud"):
            gw_mode = "local"
        gw_local = (request.form.get("gateway_local_base_url") or "").strip().rstrip("/")
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
            _write_sms_settings(
                {
                    "enabled": sms_enabled,
                    "provider": sms_provider,
                    "sender_name": sms_sender or "Beanthentic",
                    "public_base_url": public_base or str(sms_prev.get("public_base_url") or "").strip(),
                    "sms_gateway": {
                        "mode": gw_mode,
                        "local_base_url": gw_local,
                        "local_path": "/message",
                        "cloud_url": "https://api.sms-gate.app/3rdparty/v1/messages",
                        "username": gw_user,
                        "password": gw_password if gw_password is not None else "",
                        "sim_number": max(1, min(3, gw_sim)),
                    },
                }
            )
            return redirect("/connection-settings?saved=1")

    conn = _read_connection_settings()
    sms = _read_settings().get("sms")
    sms = sms if isinstance(sms, dict) else {}
    saved = (request.args.get("saved") or "").strip() == "1"
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
    gw_mode = str(gw.get("mode") or "local")
    gw_local = str(gw.get("local_base_url") or "")
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
  <p>Ilagay dito ang IP ng device na may XAMPP + Beanthentic-App DB.</p>
  {"<div class='ok'>Saved. Re-run or refresh dashboard.</div>" if saved else ""}
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
      <option value="local" {"selected" if gw_mode == "local" else ""}>local (phone on Wi‑Fi)</option>
      <option value="cloud" {"selected" if gw_mode == "cloud" else ""}>cloud (api.sms-gate.app)</option>
    </select>
    <label>Local base URL (local mode)</label>
    <input name="gateway_local_base_url" value="{gw_local}" placeholder="http://192.168.1.20:8080" />
    <label>Gateway username</label>
    <input name="gateway_username" value="{gw_user}" placeholder="from SMS Gateway app" />
    <label>Gateway password</label>
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
    """Health check endpoint for monitoring."""
    try:
        db.session.execute(text("SELECT 1"))
        return jsonify({"status": "healthy", "database": "connected"}), 200
    except Exception as e:
        return jsonify(
            {
                "status": "unhealthy",
                "database": "disconnected",
                "error": safe_error_message(e, public="Database check failed."),
            }
        ), 503


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
