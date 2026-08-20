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
from config.self_sale_audit import get_self_sale_unlock_audit, record_self_sale_unlock
from config.supabase_client import get_client, is_configured
from config.utils import get_current_admin_account, get_current_user_phone, is_authenticated, log_activity
from config.validation import validate_positive_int


def _as_bool(value) -> bool:
    return value in (True, 1, "1", "true", "True", "TRUE", "yes", "Yes", "YES")


def _pricing_unavailable():
    return jsonify({"ok": False, "error": "PRICING_NOT_CONFIGURED", "detail": "Supabase is not configured."}), 503


def _admin_unlock_actor() -> tuple[str, str]:
    account = get_current_admin_account() or {}
    phone = str(
        account.get("display_phone")
        or account.get("storage_phone")
        or get_current_user_phone()
        or ""
    ).strip()
    name = str(account.get("full_name") or "").strip()
    if not name:
        name = phone or "Admin"
    return name, phone


def _record_unlock_audit(farmer_id: int, *, enabled: bool) -> dict:
    name, phone = _admin_unlock_actor()
    if enabled:
        entry = record_self_sale_unlock(
            farmer_id,
            unlocked_by=name,
            unlocked_by_phone=phone,
            enabled=True,
        )
        log_activity(
            phone or name,
            "SELF_SALE_UNLOCKED",
            f"Farmer #{farmer_id} Records unlocked by {name} (pricelist approved)",
            request.remote_addr,
        )
        return entry
    entry = record_self_sale_unlock(
        farmer_id,
        unlocked_by=name,
        unlocked_by_phone=phone,
        enabled=False,
    )
    log_activity(
        phone or name,
        "SELF_SALE_DISABLED",
        f"Farmer #{farmer_id} self-sale disabled by {name}",
        request.remote_addr,
    )
    return entry


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
        enabled = _as_bool(data.get("enabled"))
        try:
            set_farmer_self_sale(farmer_id, enabled)
            audit = _record_unlock_audit(farmer_id, enabled=enabled)
            return jsonify({
                "ok": True,
                "farmer_id": farmer_id,
                "self_sale_enabled": enabled,
                "farmer_status": "active" if enabled else None,
                "pricelist_status": "approved" if enabled else None,
                "records_module_enabled": bool(enabled),
                "records_unlocked": bool(enabled),
                "unlock_audit": audit,
                "unlocked_by": audit.get("unlocked_by"),
                "unlocked_at": audit.get("unlocked_at"),
            })
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc, public="Could not update self-sale status.")}), 500

    @app.route("/api/farmer-self-sale-audit/<int:farmer_id>", methods=["GET"])
    def api_farmer_self_sale_audit(farmer_id: int):
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        audit = get_self_sale_unlock_audit(farmer_id) or {}
        return jsonify({"ok": True, "farmer_id": farmer_id, "unlock_audit": audit})

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
            audit = None
            if str(saved.get("status") or "").lower() == "approved":
                fid = int(saved.get("farmer_id") or 0)
                if fid > 0:
                    audit = _record_unlock_audit(fid, enabled=True)
            return jsonify({"ok": True, "item": saved, "unlock_audit": audit})
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc, public="Could not review application.")}), 500

    @app.route("/api/app/coffee-pricelist", methods=["GET", "OPTIONS"])
    def api_app_coffee_pricelist():
        # Shared official price source for Admin, Farmer portal, Mobile App, and Client Web.
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
        farmer_status = "pending"
        consolidation_preference = None
        pricelist_status = None
        try:
            fr = (
                get_client()
                .table("farmers")
                .select("status, self_sale_enabled")
                .eq("farmer_id", farmer_id)
                .limit(1)
                .execute()
            )
            if fr.data:
                farmer_status = str((fr.data[0] or {}).get("status") or "pending")
                enabled = _as_bool((fr.data[0] or {}).get("self_sale_enabled"))
            prod = (
                get_client()
                .table("production_information")
                .select("consolidation_preference, pricelist_status")
                .eq("farmer_id", farmer_id)
                .order("production_info_id", desc=True)
                .limit(1)
                .execute()
            )
            if prod.data:
                consolidation_preference = (prod.data[0] or {}).get("consolidation_preference")
                pricelist_status = str((prod.data[0] or {}).get("pricelist_status") or "").strip().lower() or None
        except Exception:
            pass

        status_l = farmer_status.strip().lower()
        pref_l = str(consolidation_preference or "").strip().lower()
        sell_path = pref_l in {"sell_produce", "drop_off_and_sell"}
        # Records unlocks when: self-sale enabled, OR account active and (not sell-path OR pricelist approved).
        records_unlocked = bool(enabled) or (
            status_l == "active" and (not sell_path or pricelist_status in {None, "", "approved"})
        )
        unlock_audit = get_self_sale_unlock_audit(farmer_id) or {}
        unlock_message = ""
        if isinstance(unlock_audit, dict) and unlock_audit:
            by = unlock_audit.get("unlocked_by") or unlock_audit.get("unlocked_by_phone") or ""
            at = unlock_audit.get("unlocked_at") or ""
            if by and at:
                unlock_message = f"Unlocked by {by} on {at}."
            elif by:
                unlock_message = f"Unlocked by {by}."
            elif at:
                unlock_message = f"Unlocked at {at}."
        return jsonify({
            "ok": True,
            "farmer_id": farmer_id,
            "self_sale_enabled": enabled,
            "farmer_status": farmer_status,
            "consolidation_preference": consolidation_preference,
            "pricelist_status": pricelist_status,
            "records_module_enabled": records_unlocked,
            "records_unlocked": records_unlocked,
            "unlock_audit": unlock_audit,
            "unlock_message": unlock_message,
        })

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
