"""Admin and mobile-app APIs for coffee pricelist and farmer self-sale price applications."""

from __future__ import annotations

from flask import jsonify, make_response, request

from config.mysql_app_bridge import connect_app_db
from config.pricing_store import (
    classification_options,
    deactivate_pricelist,
    ensure_pricing_schema,
    get_farmer_self_sale,
    list_price_applications,
    list_pricelist,
    review_price_application,
    set_farmer_self_sale,
    submit_price_application,
    upsert_pricelist,
)
from config.security import safe_error_message
from config.supabase_client import is_configured
from config.utils import is_authenticated
from config.validation import validate_positive_int


def _pricing_unavailable():
    return jsonify({"ok": False, "error": "PRICING_NOT_CONFIGURED", "detail": "Supabase is not configured."}), 503


def _ensure_schema_once():
    if not is_configured():
        return
    try:
        conn = connect_app_db({})
        try:
            ensure_pricing_schema(conn)
        finally:
            conn.close()
    except Exception as exc:
        print(f"[Beanthentic] pricing schema ensure skipped: {exc}")


def register_pricing_routes(app):
    @app.route("/api/coffee-pricelist", methods=["GET"])
    def api_coffee_pricelist_get():
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        if not is_configured():
            return _pricing_unavailable()
        try:
            _ensure_schema_once()
            # Official pricelist is one active row per variety.
            items = list_pricelist(active_only=True)
            return jsonify({"ok": True, "items": items, "options": classification_options()})
        except Exception as exc:
            return jsonify(
                {
                    "ok": False,
                    "error": safe_error_message(exc, public="Could not load coffee pricelist."),
                }
            ), 500

    @app.route("/api/coffee-pricelist", methods=["POST"])
    def api_coffee_pricelist_upsert():
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        if not is_configured():
            return _pricing_unavailable()
        _ensure_schema_once()
        data = request.get_json(silent=True) or {}
        try:
            saved = upsert_pricelist(data)
            return jsonify({"ok": True, "item": saved})
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc, public="Could not save pricelist row.")}), 500

    @app.route("/api/coffee-pricelist/<int:price_id>", methods=["DELETE"])
    def api_coffee_pricelist_delete(price_id: int):
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        if not is_configured():
            return _pricing_unavailable()
        _ensure_schema_once()
        try:
            ok = deactivate_pricelist(price_id)
            if not ok:
                return jsonify({"ok": False, "error": "Price row not found."}), 404
            return jsonify({"ok": True, "price_id": price_id})
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc, public="Could not deactivate price row.")}), 500

    @app.route("/api/farmer-self-sale", methods=["POST"])
    def api_farmer_self_sale():
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        if not is_configured():
            return _pricing_unavailable()
        _ensure_schema_once()
        data = request.get_json(silent=True) or {}
        ok_fid, fid_err, farmer_id = validate_positive_int(data.get("farmer_id"), field="farmer_id", minimum=1)
        if not ok_fid:
            return jsonify({"ok": False, "error": fid_err}), 400
        enabled = bool(data.get("enabled"))
        try:
            set_farmer_self_sale(farmer_id, enabled)
            return jsonify({"ok": True, "farmer_id": farmer_id, "self_sale_enabled": enabled})
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc, public="Could not update self-sale status.")}), 500

    @app.route("/api/farmer-price-applications", methods=["GET"])
    def api_farmer_price_applications():
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        if not is_configured():
            return _pricing_unavailable()
        try:
            _ensure_schema_once()
            farmer_id = None
            if request.args.get("farmer_id"):
                ok_fid, fid_err, farmer_id = validate_positive_int(
                    request.args.get("farmer_id"), field="farmer_id", minimum=1
                )
                if not ok_fid:
                    return jsonify({"ok": False, "error": fid_err}), 400
            status = (request.args.get("status") or "").strip() or None
            items = list_price_applications(farmer_id=farmer_id, status=status)
            return jsonify({"ok": True, "items": items})
        except Exception as exc:
            return jsonify(
                {
                    "ok": False,
                    "error": safe_error_message(exc, public="Could not load price applications."),
                    "items": [],
                }
            ), 500

    @app.route("/api/farmer-price-applications/<int:application_id>/review", methods=["POST"])
    def api_review_price_application(application_id: int):
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        if not is_configured():
            return _pricing_unavailable()
        _ensure_schema_once()
        data = request.get_json(silent=True) or {}
        try:
            saved = review_price_application(
                application_id,
                status=str(data.get("status") or ""),
                admin_notes=str(data.get("admin_notes") or ""),
            )
            if not saved:
                return jsonify({"ok": False, "error": "Application not found."}), 404
            return jsonify({"ok": True, "item": saved})
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc, public="Could not review application.")}), 500

    @app.route("/api/app/coffee-pricelist", methods=["GET", "OPTIONS"])
    def api_app_coffee_pricelist():
        if request.method == "OPTIONS":
            return make_response("", 204)
        if not is_configured():
            return _pricing_unavailable()
        _ensure_schema_once()
        items = list_pricelist(active_only=True)
        return jsonify({"ok": True, "items": items, "options": classification_options()})

    @app.route("/api/app/farmer-self-sale", methods=["GET", "OPTIONS"])
    def api_app_farmer_self_sale():
        if request.method == "OPTIONS":
            return make_response("", 204)
        if not is_configured():
            return _pricing_unavailable()
        _ensure_schema_once()
        ok_fid, fid_err, farmer_id = validate_positive_int(
            request.args.get("farmer_id") or request.args.get("farmer_no"),
            field="farmer_id",
            minimum=1,
        )
        if not ok_fid:
            return jsonify({"ok": False, "error": fid_err}), 400
        enabled = get_farmer_self_sale(farmer_id)
        return jsonify({"ok": True, "farmer_id": farmer_id, "self_sale_enabled": enabled})

    @app.route("/api/app/farmer-price-application", methods=["POST", "OPTIONS"])
    def api_app_farmer_price_application():
        if request.method == "OPTIONS":
            return make_response("", 204)
        if not is_configured():
            return _pricing_unavailable()
        _ensure_schema_once()
        data = request.get_json(silent=True) or {}
        try:
            saved = submit_price_application(data)
            return jsonify({"ok": True, "item": saved})
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc, public="Could not submit price application.")}), 500

    @app.route("/api/app/farmer-price-applications", methods=["GET", "OPTIONS"])
    def api_app_farmer_price_applications():
        if request.method == "OPTIONS":
            return make_response("", 204)
        if not is_configured():
            return _pricing_unavailable()
        _ensure_schema_once()
        ok_fid, fid_err, farmer_id = validate_positive_int(
            request.args.get("farmer_id") or request.args.get("farmer_no"),
            field="farmer_id",
            minimum=1,
        )
        if not ok_fid:
            return jsonify({"ok": False, "error": fid_err}), 400
        items = list_price_applications(farmer_id=farmer_id)
        return jsonify({"ok": True, "items": items})
