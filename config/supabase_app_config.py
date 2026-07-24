"""Shared Supabase + cross-app connection config for Admin, App, and Client Web."""

from __future__ import annotations

import os

import beanthentic_env
from config.supabase_client import is_configured, public_config, verify_connection


def shared_app_config() -> dict:
    """Public config payload for /api/supabase-config (all three apps)."""
    if not is_configured():
        return {
            "ok": False,
            "error": "Supabase not configured. Set BEANTHENTIC_SUPABASE_URL and BEANTHENTIC_SUPABASE_ANON_KEY in .env",
        }

    ok, err = verify_connection()
    cfg = public_config()
    app_base = os.getenv("BEANTHENTIC_APP_SERVER_BASE", "").strip().rstrip("/") or None
    admin_base = beanthentic_env.admin_public_base() or None

    return {
        "ok": ok,
        "mode": "supabase_anon",
        "supabase_url": cfg.get("supabase_url"),
        "supabase_anon_key": cfg.get("supabase_anon_key"),
        "supabase_project_ref": cfg.get("supabase_project_ref"),
        "admin_api_base": admin_base,
        "app_server_base": app_base,
        "storage_bucket": beanthentic_env.supabase_storage_bucket(),
        "endpoints": {
            "connection_status": f"{admin_base}/api/connection-status" if admin_base else "/api/connection-status",
            "supabase_config": f"{admin_base}/api/supabase-config" if admin_base else "/api/supabase-config",
            "health": f"{admin_base}/health" if admin_base else "/health",
        },
        "error": None if ok else err,
    }
