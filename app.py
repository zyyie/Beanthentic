
"""
Beanthentic-App server (port 8080) — Supabase + admin HTTP bridges.

Mobile app and optional LAN bridges use the same Supabase anon key as Admin/Client.
Copy .env from the Admin project or set BEANTHENTIC_SUPABASE_* variables here.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from flask import Flask, jsonify, make_response, request

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: E402

app = Flask(__name__)


@app.after_request
def _cors(response):
    path = request.path or ""
    if path.startswith("/api/"):
        origin = (request.headers.get("Origin") or "").strip()
        response.headers["Access-Control-Allow-Origin"] = origin or "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Accept"
    return response


@app.route("/api/connection-status", methods=["GET", "OPTIONS"])
def api_connection_status():
    if request.method == "OPTIONS":
        return make_response("", 204)
    from beanthentic_env import verify_connection, supabase_url

    ok, err = verify_connection()
    return jsonify(
        {
            "ok": ok,
            "mode": "supabase_anon",
            "supabase_url": supabase_url() or None,
            "database_ok": ok,
            "error": None if ok else err,
        }
    ), (200 if ok else 503)


@app.route("/api/supabase-config", methods=["GET", "OPTIONS"])
def api_supabase_config():
    if request.method == "OPTIONS":
        return make_response("", 204)
    from config.supabase_app_config import shared_app_config

    payload = shared_app_config()
    return jsonify(payload), (200 if payload.get("ok") else 503)


try:
    from deploy.app_server.admin_bridges import register_admin_bridges

    register_admin_bridges(app)
except ImportError:
    try:
        from admin_bridges import register_admin_bridges

        register_admin_bridges(app)
    except ImportError as exc:
        print(f"Warning: admin_bridges not registered: {exc}")


@app.route("/health", methods=["GET"])
def health():
    from beanthentic_env import verify_connection

    ok, err = verify_connection()
    return jsonify({"ok": ok, "service": "beanthentic-app", "error": None if ok else err}), (200 if ok else 503)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    ok, err = beanthentic_env.verify_connection()
    print("[Beanthentic-App] Supabase:")
    print(f"  URL: {beanthentic_env.supabase_url() or '(not set)'}")
    print(f"  REST: {'OK' if ok else f'FAIL — {err}'}")
    print(f"  Config: http://127.0.0.1:{port}/api/supabase-config")
    print(f"  Health: http://127.0.0.1:{port}/health")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
