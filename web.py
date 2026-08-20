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

import beanthentic_env

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
from api.pricing_api import register_pricing_routes
from api.system_check_api import register_system_check_routes
from api.calendar_notes_api import register_calendar_notes_routes
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
    if path.startswith("/api/") or path in ("/health", "/api/connection-status", "/api/supabase-config"):
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
    if not path.startswith("/api/"):
        response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=()")
        # Undo browser HSTS from earlier dev HTTPS — admin is HTTP-only on port 5000.
        try:
            if request.scheme == "http":
                response.headers["Strict-Transport-Security"] = "max-age=0"
        except RuntimeError:
            pass
    return response


@app.route("/open-admin")
def open_admin_redirect():
    """Bookmark this path as http://127.0.0.1:5000/open-admin (never https)."""
    port = request.environ.get("SERVER_PORT") or os.getenv("PORT", "5000")
    target = f"http://127.0.0.1:{port}/dashboard"
    return redirect(target, code=302)


@app.route("/api/connection-status", methods=["GET", "OPTIONS"])
def api_connection_status():
    """Public Supabase connection diagnostic (no admin login required)."""
    if request.method == "OPTIONS":
        return make_response("", 204)

    from config.supabase_app_config import shared_app_config

    payload = shared_app_config()
    code = 200 if payload.get("ok") else 503
    return jsonify(payload), code


@app.route("/api/supabase-config", methods=["GET", "OPTIONS"])
def api_supabase_config():
    """
    Shared Supabase URL + anon key for Beanthentic-App and Beanthentic-Client.
    The anon key is public by design (RLS enforces access rules).
    """
    if request.method == "OPTIONS":
        return make_response("", 204)

    from config.supabase_app_config import shared_app_config

    payload = shared_app_config()
    code = 200 if payload.get("ok") else 503
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


def _build_database_url_from_connection(conn: dict) -> str:
    """
    Build SQLAlchemy database URL from settings.json connection block.
    Supports both MySQL and PostgreSQL (Supabase).
    """
    # First check if connection already provides a full URL
    full_url = str(conn.get("app_db_url") or "").strip()
    if full_url:
        return full_url

    # If no full URL, build from components - default to MySQL
    host = str(conn.get("app_db_host") or "").strip()
    if not host:
        return ""

    # Determine which dialect to use
    dialect = str(conn.get("app_db_dialect") or "mysql").strip().lower()
    user = str(conn.get("app_db_user") or "root").strip() or "root"
    password = str(conn.get("app_db_pass") if conn.get("app_db_pass") is not None else "")
    db_name = str(conn.get("app_db_name") or "beanthentic_app").strip() or "beanthentic_app"
    port_raw = conn.get("app_db_port", 3306)
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        port = 3306

    port_part = f":{port}" if port else ""

    if dialect in ("postgresql", "postgres"):
        return f"postgresql://{user}:{password}@{host}{port_part}/{db_name}"
    else:  # default to mysql
        return f"mysql+pymysql://{user}:{password}@{host}{port_part}/{db_name}"


# SQLAlchemy configuration
# Only use beanthentic_env for Supabase
database_url = beanthentic_env.sqlalchemy_database_url()
if not database_url or not database_url.strip():
    raise RuntimeError(
        "No database configured. Set up .env with BEANTHENTIC_DB_TYPE=postgresql and other BEANTHENTIC_* variables."
    )

app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
_sqlalchemy_backend = beanthentic_env.sqlalchemy_backend()
_engine_options: dict = {"pool_pre_ping": True}
if _sqlalchemy_backend == "sqlite_local":
    # SQLite rejects MySQL/Postgres connect_timeout kwargs
    _engine_options["connect_args"] = {"check_same_thread": False}
else:
    _engine_options["connect_args"] = {"connect_timeout": app_db_connect_timeout(8)}
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = _engine_options

# Initialize database
db.init_app(app)


def _init_database_schema() -> None:
    """
    Create / migrate SQLAlchemy tables for the active backend.

    - sqlite_local: admin-only ORM tables while Supabase anon REST serves farmers.
    - postgresql (BEANTHENTIC_DB_URL): migrate App schema columns only — do not
      create_all() legacy models against the live Supabase schema.
    - mysql: create_all for local admin DB.
    """
    backend = beanthentic_env.sqlalchemy_backend()
    if backend == "sqlite_local":
        db.create_all()
        _ensure_admin_users_table()
        return
    if backend == "postgresql" or (
        beanthentic_env.is_postgresql() and beanthentic_env.get_db_url()
    ):
        _ensure_farmer_profile_photo_column()
        _ensure_production_detail_columns()
        _ensure_pricing_schema()
        _ensure_admin_users_table()
        return
    db.create_all()
    _ensure_admin_users_table()


def _ensure_admin_users_table() -> None:
    """Ensure admin_user exists and JSON accounts are synced to the database."""
    from config.utils import ensure_admin_users_migrated

    try:
        ensure_admin_users_migrated()
    except Exception as exc:
        print(f"[Beanthentic] admin_user migration skipped: {exc}")


def _ensure_production_detail_columns() -> None:
    """Add harvest / GCB / roasted detail columns on production_information."""
    try:
        from config.mysql_app_bridge import connect_app_db
        from config.production_fields import ensure_current_app_schema_columns, ensure_production_detail_columns
        from config.supabase_production_sync import (
            backfill_production_classifications_from_detail,
            backfill_production_detail_from_legacy,
            sync_production_bean_classifications,
        )

        conn = connect_app_db({})
        try:
            added = ensure_production_detail_columns(conn)
            if added:
                print(f"[Beanthentic] production_information: added {len(added)} column(s)")
            registration_added = ensure_current_app_schema_columns(conn)
            if registration_added:
                print(f"[Beanthentic] current app schema: added {len(registration_added)} column(s)")
            updated = backfill_production_detail_from_legacy(conn)
            if updated:
                print(f"[Beanthentic] production_information: backfilled {updated} row(s) from legacy qty")
            class_updated = backfill_production_classifications_from_detail(conn)
            if class_updated:
                print(
                    f"[Beanthentic] production_information: synced classifications for {class_updated} row(s)"
                )
            bean_class_synced = sync_production_bean_classifications(conn)
            if bean_class_synced:
                print(
                    f"[Beanthentic] production_information: synced {bean_class_synced} classification(s) from production_bean_classifications"
                )
        finally:
            conn.close()
    except Exception as exc:
        print(f"[Beanthentic] production detail columns skipped: {exc}")


def _ensure_pricing_schema() -> None:
    """Create coffee pricelist tables and farmers.self_sale_enabled when missing."""
    try:
        from config.mysql_app_bridge import connect_app_db
        from config.pricing_store import ensure_pricing_schema

        conn = connect_app_db({})
        try:
            ensure_pricing_schema(conn)
        finally:
            conn.close()
    except Exception as exc:
        print(f"[Beanthentic] pricing schema migration skipped: {exc}")


def _ensure_farmer_profile_photo_column() -> None:
    """Allow Supabase URLs and data-URL fallbacks in farmers.profile_photo."""
    try:
        db.session.execute(text("ALTER TABLE farmers ALTER COLUMN profile_photo TYPE TEXT"))
        db.session.commit()
    except Exception:
        db.session.rollback()


with app.app_context():
        _init_database_schema()

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
2

register_platform_routes(app)
register_ml_routes(app)
register_pricing_routes(app)
register_system_check_routes(app)
register_calendar_notes_routes(app)
register_farmer_portal_routes(app)


def _log_ipophl_ml_readiness() -> None:
    """Log whether document/farmer ML models are loaded (helps diagnose 0% analysis)."""
    try:
        from machinelearning.ai_engine import gi_analyzer

        status = gi_analyzer.ml_status()
        if not status.get("document_model_loaded"):
            app.logger.warning(
                "IPOPHL document ML model not loaded. Build official MoP dataset and train: "
                "python scripts/build_official_mop_dataset.py --train"
            )
        else:
            app.logger.info(
                "IPOPHL AI ready (document=%s, mode=%s)",
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


from routes.connection_settings import register_connection_settings_routes

register_connection_settings_routes(
    app,
    settings_path=SETTINGS_PATH,
    read_settings=_read_settings,
    write_connection_settings=_write_connection_settings,
)

# Health check endpoint
@app.route("/health")
def health():
    """Health check — Supabase anon connection."""
    from config.ipophl_store import STORE_PATH
    from config.supabase_client import is_configured, verify_connection, public_config
    from config.sms import SMS_BUILD_ID

    sb_ok, sb_err = verify_connection() if is_configured() else (False, "Supabase not configured")
    payload: dict = {
        "status": "healthy" if sb_ok else "degraded",
        "admin_server": "up",
        "sms_build": SMS_BUILD_ID,
        "mode": "supabase_anon",
        "supabase": "connected" if sb_ok else "disconnected",
        "supabase_url": public_config().get("supabase_url") if is_configured() else None,
        "database": "supabase" if sb_ok else "disconnected",
        "ipophl_local": "available" if STORE_PATH.exists() else "ready",
    }
    if not sb_ok:
        payload["supabase_error"] = sb_err
        payload["hint"] = "Set BEANTHENTIC_SUPABASE_URL and BEANTHENTIC_SUPABASE_ANON_KEY in .env"

    payload["sqlalchemy_backend"] = beanthentic_env.sqlalchemy_backend()
    try:
        db.session.execute(text("SELECT 1"))
        payload["sqlalchemy"] = "connected"
        if payload["sqlalchemy_backend"] == "sqlite_local":
            payload["sqlalchemy_note"] = (
                "Local SQLite admin tables. Set BEANTHENTIC_DB_URL for direct Supabase SQL."
            )
    except Exception as e:
        payload["sqlalchemy"] = "disconnected"
        payload["sqlalchemy_error"] = safe_error_message(e, public="SQLAlchemy ping failed.")
        if not beanthentic_env.get_db_url():
            payload["hint_sqlalchemy"] = (
                "Add BEANTHENTIC_DB_URL (or BEANTHENTIC_DB_TYPE=postgresql + host/user/pass) "
                "in .env for direct Supabase SQLAlchemy."
            )

    code = 200 if sb_ok else 503
    return jsonify(payload), code


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    try:
        from config.supabase_client import is_configured, verify_connection, public_config

        cfg = public_config() if is_configured() else {}
        ok, err = verify_connection() if is_configured() else (False, "not configured")
        print("[Beanthentic] Supabase setup:")
        print(f"  URL: {cfg.get('supabase_url') or '(not set)'}")
        print(f"  Anon key: {'(set)' if cfg.get('supabase_anon_key') else '(not set)'}")
        print(f"  REST API: {'OK' if ok else f'FAIL — {err}'}")
        print(f"  App/Client config: http://127.0.0.1:{port}/api/supabase-config")
        print(f"  Diagnostic: http://127.0.0.1:{port}/api/connection-status")
        print(f"  Admin (camera): http://127.0.0.1:{port}/dashboard")
        print(f"  Quick open:     http://127.0.0.1:{port}/open-admin")
        print("  Use http:// only — not https:// (no certificate warnings).")
        print("  If Chrome still forces https, visit chrome://net-internals/#hsts")
        print("  and delete domain: 192.168.18.126")
    except Exception as boot_exc:
        print(f"[Beanthentic] Startup diagnostic skipped: {boot_exc}")
    app.run(host="0.0.0.0", port=port, debug=debug, threaded=True)
