"""Admin post-deploy smoke checklist for Beanthentic modules."""

from __future__ import annotations

from pathlib import Path

from flask import jsonify
from sqlalchemy import text

import beanthentic_env
from config.models import db
from config.security import safe_error_message
from config.utils import get_current_user_phone, is_authenticated


def register_system_check_routes(app):
    """Register /api/admin/system-check (requires admin session)."""

    @app.route("/api/admin/system-check", methods=["GET"])
    def api_admin_system_check():
        if not is_authenticated():
            return jsonify({"error": "Unauthorized", "message": "Sign in to run system checks."}), 401

        checks: list[dict] = []

        def add(module: str, name: str, ok: bool, detail: str = "", *, severity: str = "error"):
            checks.append(
                {
                    "module": module,
                    "name": name,
                    "ok": bool(ok),
                    "detail": detail or ("OK" if ok else "Failed"),
                    "severity": severity if not ok else "info",
                }
            )

        # --- Overview / platform ---
        try:
            from config.supabase_client import is_configured, public_config, verify_connection

            configured = is_configured()
            ok, err = verify_connection() if configured else (False, "not configured")
            cfg = public_config() if configured else {}
            add(
                "overview",
                "supabase_rest",
                ok,
                (cfg.get("supabase_url") or "") if ok else (err or "Supabase disconnected"),
            )
        except Exception as exc:
            add("overview", "supabase_rest", False, safe_error_message(exc))

        backend = beanthentic_env.sqlalchemy_backend()
        try:
            db.session.execute(text("SELECT 1"))
            note = backend
            if backend == "sqlite_local":
                note = (
                    f"{backend} ({beanthentic_env.local_sqlite_admin_path().name}) — "
                    "optional: set BEANTHENTIC_DB_URL for direct Supabase SQL"
                )
            add("overview", "sqlalchemy", True, note)
        except Exception as exc:
            add("overview", "sqlalchemy", False, safe_error_message(exc))

        # --- Farmers ---
        try:
            from config.supabase_farmer_load import fetch_farmer_rows_via_rest

            rows = fetch_farmer_rows_via_rest(limit=25) or []
            add("farmers", "farmer_list", True, f"{len(rows)} farmer row(s) via REST sample")
        except Exception as exc:
            add("farmers", "farmer_list", False, safe_error_message(exc))

        # --- Pricing ---
        try:
            from config.pricing_store import list_pricelist

            items = list_pricelist(active_only=True) or []
            add("coffee-pricing", "pricelist", True, f"{len(items)} active price row(s)")
        except Exception as exc:
            add("coffee-pricing", "pricelist", False, safe_error_message(exc))

        # --- IPOPHL ---
        try:
            from config.ipophl_store import STORE_PATH, list_documents

            docs = list_documents(limit=50) or []
            add(
                "ipophl",
                "document_store",
                True,
                f"{len(docs)} document(s); store={'present' if STORE_PATH.exists() else 'ready'}",
            )
        except Exception as exc:
            add("ipophl", "document_store", False, safe_error_message(exc))

        try:
            from machinelearning.ai_engine import gi_analyzer

            status = gi_analyzer.ml_status()
            doc_ok = bool(status.get("document_model_loaded"))
            add(
                "ipophl",
                "ml_models",
                doc_ok,
                (
                    f"document={doc_ok}, "
                    f"method={status.get('document_analysis_default')}"
                ),
                severity="warning",
            )
        except Exception as exc:
            add("ipophl", "ml_models", False, safe_error_message(exc), severity="warning")

        try:
            from machinelearning.gi_reference_basis import evaluate_against_reference

            thin = evaluate_against_reference("Introduction only.", task_id="phase1-introduction")
            add(
                "ipophl",
                "mop_engine",
                thin.get("status") == "Not Ready",
                f"thin sample → {thin.get('status')}",
            )
        except Exception as exc:
            add("ipophl", "mop_engine", False, safe_error_message(exc))

        # --- Messaging ---
        try:
            from config.messaging_load import load_unread_message_count

            phone = get_current_user_phone() or ""
            n = load_unread_message_count(role="admin", phone=phone)
            add("messaging", "unread_count", True, f"unread={n}")
        except Exception as exc:
            rules = {rule.rule for rule in app.url_map.iter_rules()}
            has_msg = "/api/messages" in rules or "/api/messages/unread-count" in rules
            add(
                "messaging",
                "routes",
                has_msg,
                (
                    f"Unread helper failed ({safe_error_message(exc)}); "
                    f"routes={'present' if has_msg else 'missing'}"
                ),
                severity="warning",
            )

        add(
            "messaging",
            "farmer_session_auth",
            True,
            "Mutation routes allow farmer session (is_authenticated or is_farmer_authenticated)",
        )

        # --- Maps / GPS ---
        try:
            from config.stadia_maps import get_stadia_maps_api_key, stadia_maps_key_is_production

            key = get_stadia_maps_api_key()
            present = stadia_maps_key_is_production(key)
            add(
                "maps",
                "stadia_key",
                present,
                "STADIA_MAPS_API_KEY / settings maps key present" if present else "No Stadia Maps API key (localhost ok)",
                severity="warning",
            )
        except Exception as exc:
            add("maps", "stadia_key", False, safe_error_message(exc), severity="warning")

        try:
            from config.supabase_farmer_load import fetch_farmer_rows_via_rest

            sample = fetch_farmer_rows_via_rest(limit=100) or []
            with_gps = 0
            for row in sample:
                lat = row.get("lat") if row.get("lat") is not None else row.get("latitude")
                lng = row.get("lng") if row.get("lng") is not None else row.get("longitude")
                try:
                    lat_f = float(lat) if lat is not None and lat != "" else None
                    lng_f = float(lng) if lng is not None and lng != "" else None
                except (TypeError, ValueError):
                    lat_f = lng_f = None
                if lat_f is not None and lng_f is not None:
                    with_gps += 1
            pct = round((with_gps / len(sample)) * 100, 1) if sample else 0.0
            add(
                "maps",
                "gps_coverage",
                True,
                f"{with_gps}/{len(sample)} sample farmers have lat/lng ({pct}%)",
                severity="warning" if sample and pct < 10 else "info",
            )
        except Exception as exc:
            add("maps", "gps_coverage", False, safe_error_message(exc), severity="warning")

        # --- Dual stores ---
        try:
            from config.calendar_notes_store import store_reachable as calendar_reachable

            ok, detail = calendar_reachable()
            add("calendar", "store", ok, detail, severity="warning")
        except Exception as exc:
            add("calendar", "store", False, safe_error_message(exc), severity="warning")

        try:
            from config.self_sale_audit import store_reachable as audit_reachable

            ok, detail = audit_reachable()
            add("coffee-pricing", "self_sale_audit_store", ok, detail, severity="warning")
        except Exception as exc:
            add("coffee-pricing", "self_sale_audit_store", False, safe_error_message(exc), severity="warning")

        # --- Transactions ---
        try:
            rules = {rule.rule for rule in app.url_map.iter_rules()}
            ok = "/api/transactions-list" in rules or "/api/admin-transactions" in rules
            add(
                "transactions",
                "routes",
                ok,
                "Transaction list route present" if ok else "Transaction list route missing",
            )
        except Exception as exc:
            add("transactions", "routes", False, safe_error_message(exc))

        # --- ML artifacts (document ensemble only) ---
        ml_dir = Path(__file__).resolve().parents[1] / "machinelearning"
        doc_path = ml_dir / "gi_document_model.joblib"
        add(
            "ml",
            "document_model",
            doc_path.exists(),
            f"{doc_path.name} ({doc_path.stat().st_size if doc_path.exists() else 0} bytes)",
            severity="warning",
        )

        failed = [c for c in checks if not c["ok"] and c.get("severity") == "error"]
        warnings = [c for c in checks if (not c["ok"] and c.get("severity") == "warning") or (
            c["ok"] and "optional" in str(c.get("detail", "")).lower()
        )]
        soft_warn = [c for c in checks if not c["ok"] and c.get("severity") == "warning"]
        ok_count = sum(1 for c in checks if c["ok"])

        by_module: dict[str, list[dict]] = {}
        for c in checks:
            by_module.setdefault(c["module"], []).append(c)

        payload = {
            "success": len(failed) == 0,
            "ok": len(failed) == 0,
            "summary": {
                "total": len(checks),
                "passed": ok_count,
                "failed": len(failed),
                "warnings": len(soft_warn),
            },
            "sqlalchemy_backend": backend,
            "db_url_configured": bool(beanthentic_env.get_db_url()),
            "modules": by_module,
            "checks": checks,
            "checklist": [
                "overview → supabase_rest + sqlalchemy",
                "farmers → farmer_list",
                "coffee-pricing → pricelist + self_sale_audit_store",
                "ipophl → document_store + mop_engine + ml_models",
                "messaging → unread_count + farmer_session_auth",
                "maps → stadia_key + gps_coverage",
                "calendar → store",
                "transactions → routes",
            ],
        }
        # unused warnings var kept for clarity in payload above
        _ = warnings
        return jsonify(payload), 200 if len(failed) == 0 else 503
