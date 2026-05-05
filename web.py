"""
Beanthentic - Coffee Farmer Management System

A Flask-based web application for managing coffee farmer records,
including farmer registration, production tracking, IPOPHL document
analysis, and administrative functions.
"""

import os

from flask import Flask, jsonify
from sqlalchemy import text

from config.auth import register_auth_routes
from config.models import db
from api.export_api import register_export_routes
from api.farmer_api import register_farmer_routes
from api.ipophl_api import register_ipophl_routes
from api.messaging_api import register_messaging_routes
from routes.dashboard import register_dashboard_routes

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = "beanthentic-dev-secret-change-this"

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

    if mysql_user and mysql_password and mysql_host and mysql_db:
        database_url = f"mysql+pymysql://{mysql_user}:{mysql_password}@{mysql_host}/{mysql_db}"
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
register_messaging_routes(app)

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
