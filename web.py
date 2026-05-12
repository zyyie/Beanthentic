"""
Beanthentic - Coffee Farmer Management System

A Flask-based web application for managing coffee farmer records,
including farmer registration, production tracking, IPOPHL document
analysis, and administrative functions.
"""

import json
import os
from pathlib import Path

from flask import Flask, jsonify, redirect, request
from sqlalchemy import text

from config.auth import register_auth_routes
from config.models import db
from api.export_api import register_export_routes
from api.farmer_api import register_farmer_routes
from api.ipophl_api import register_ipophl_routes
from api.misconduct_report_api import register_misconduct_report_routes
from api.messaging_api import register_messaging_routes
from api.platform_api import register_platform_routes
from routes.dashboard import register_dashboard_routes
from routes.farmer_portal import register_farmer_portal_routes

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = "beanthentic-dev-secret-change-this"
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

# SQLAlchemy configuration
# Priority:
# 1) DATABASE_URL env var (full SQLAlchemy URL)
# 2) MySQL from env vars (MYSQL_USER/MYSQL_PASSWORD/MYSQL_HOST/MYSQL_DB)
# 3) Local SQLite fallback for easy local startup
database_url = os.getenv("DATABASE_URL", "").strip()
if not database_url:
    mysql_user = os.getenv("MYSQL_USER", "").strip()
    mysql_password = os.getenv("MYSQL_PASSWORD", "")
    mysql_host = os.getenv("MYSQL_HOST", "").strip()
    mysql_db = os.getenv("MYSQL_DB", "").strip()
    mysql_port = os.getenv("MYSQL_PORT", "").strip()

    # NOTE: XAMPP often uses blank root password on LAN/dev.
    # Treat "MYSQL_PASSWORD missing" differently from "MYSQL_PASSWORD is empty string".
    if mysql_user and mysql_host and mysql_db:
        port_part = f":{mysql_port}" if mysql_port else ""
        # SQLAlchemy URL: mysql+pymysql://user:pass@host:port/db
        database_url = f"mysql+pymysql://{mysql_user}:{mysql_password}@{mysql_host}{port_part}/{mysql_db}"
    else:
        database_url = "sqlite:///beanthentic.db"

app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True}

# Initialize database
db.init_app(app)

# Create tables
with app.app_context():
    try:
        db.create_all()
    except Exception as e:
        print(f"Warning: Could not create tables: {e}")

# Register all route modules
register_auth_routes(app)
register_dashboard_routes(app)
register_farmer_routes(app)
register_export_routes(app)
register_ipophl_routes(app)
register_misconduct_report_routes(app)
register_messaging_routes(app)
register_platform_routes(app)
register_farmer_portal_routes(app)


@app.route("/connection-settings", methods=["GET", "POST"])
def connection_settings():
    """Manual UI to set cross-device DB connection IP/port for admin web."""
    if request.method == "POST":
        host = (request.form.get("app_db_host") or "").strip()
        port_raw = (request.form.get("app_db_port") or "3306").strip()
        user = (request.form.get("app_db_user") or "root").strip() or "root"
        password = request.form.get("app_db_pass") or ""
        db_name = (request.form.get("app_db_name") or "beanthentic_app").strip() or "beanthentic_app"
        try:
            port = int(port_raw)
        except ValueError:
            port = 3306
        _write_connection_settings(
            {
                "app_db_host": host,
                "app_db_port": port,
                "app_db_user": user,
                "app_db_pass": password,
                "app_db_name": db_name,
            }
        )
        return redirect("/connection-settings?saved=1")

    conn = _read_connection_settings()
    saved = (request.args.get("saved") or "").strip() == "1"
    host = str(conn.get("app_db_host") or "")
    port = str(conn.get("app_db_port") or 3306)
    user = str(conn.get("app_db_user") or "root")
    db_name = str(conn.get("app_db_name") or "beanthentic_app")
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connection Settings</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; max-width: 700px; }}
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
        return jsonify({"status": "unhealthy", "database": "disconnected", "error": str(e)}), 503


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
