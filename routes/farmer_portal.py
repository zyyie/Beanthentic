"""
Farmer portal routes.

Provides farmer login, OTP password reset, home dashboard, and messaging UI.
"""

from flask import flash, jsonify, redirect, render_template, request, session, url_for

from config.farmer_auth import authenticate_farmer, lookup_farmer_by_phone, update_farmer_password
from config.otp import OTP_PURPOSE_FARMER, create_otp, verify_otp
from config.sms import send_otp_sms
from config.validation import validate_password, validate_phone
from config.utils import get_current_farmer_phone, is_farmer_authenticated, log_activity

OTP_SESSION_PHONE = "farmer_reset_phone"
OTP_SESSION_USER_ID = "farmer_reset_user_id"


def _portal_status_payload(farmer_id: int | None, phone: str) -> dict:
    unread_count = 0
    try:
        from config.messaging_load import load_unread_message_count

        unread_count = int(load_unread_message_count(role="farmer", phone=phone) or 0)
    except Exception:
        unread_count = 0

    self_sale_enabled = False
    records_unlocked = False
    unlock_audit = None
    unlock_message = ""
    pricelist: list = []

    if farmer_id and farmer_id > 0:
        try:
            from config.self_sale_audit import get_self_sale_unlock_audit

            unlock_audit = get_self_sale_unlock_audit(farmer_id)
        except Exception:
            unlock_audit = None

        try:
            from config.pricing_store import get_farmer_self_sale, list_pricelist
            from config.supabase_client import get_client, is_configured

            if is_configured():
                self_sale_enabled = bool(get_farmer_self_sale(farmer_id))
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
                        value = (fr.data[0] or {}).get("self_sale_enabled")
                        self_sale_enabled = value in (
                            True, 1, "1", "true", "True", "TRUE", "yes", "Yes", "YES"
                        )
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
                        pricelist_status = (
                            str((prod.data[0] or {}).get("pricelist_status") or "").strip().lower() or None
                        )
                except Exception:
                    pass

                status_l = farmer_status.strip().lower()
                pref_l = str(consolidation_preference or "").strip().lower()
                sell_path = pref_l in {"sell_produce", "drop_off_and_sell"}
                records_unlocked = bool(self_sale_enabled) or (
                    status_l == "active" and (not sell_path or pricelist_status in {None, "", "approved"})
                )
                pricelist = list_pricelist(active_only=True) or []
        except Exception:
            pass

    if isinstance(unlock_audit, dict):
        by = unlock_audit.get("unlocked_by") or unlock_audit.get("unlocked_by_phone") or ""
        at = unlock_audit.get("unlocked_at") or ""
        if by and at:
            unlock_message = f"Unlocked by {by} on {at}."
        elif by:
            unlock_message = f"Unlocked by {by}."
        elif at:
            unlock_message = f"Unlocked at {at}."

    return {
        "ok": True,
        "farmer_id": farmer_id,
        "unread_count": unread_count,
        "self_sale_enabled": self_sale_enabled,
        "records_unlocked": records_unlocked,
        "unlock_audit": unlock_audit,
        "unlock_message": unlock_message,
        "pricelist": pricelist,
    }


def register_farmer_portal_routes(app):
    @app.route("/farmer/login", methods=["GET", "POST"])
    def farmer_login():
        error = ""
        if request.method == "POST":
            phone = (request.form.get("phone") or "").strip()
            password = request.form.get("password") or ""

            ok_phone, phone_err, phone = validate_phone(phone)
            if not ok_phone:
                error = phone_err
            else:
                farmer, auth_err = authenticate_farmer(phone, password)
                if not farmer:
                    error = auth_err or "Could not sign in."
                else:
                    session.clear()
                    session["farmer_phone"] = phone
                    session["farmer_name"] = farmer.get("display_name") or f"Farmer +63{phone}"
                    try:
                        session["farmer_id"] = int(farmer.get("farmer_id") or 0) or None
                    except (TypeError, ValueError):
                        session["farmer_id"] = None
                    try:
                        log_activity(phone, "FARMER_LOGIN", "Farmer logged in", request.remote_addr)
                    except Exception:
                        pass
                    return redirect(url_for("farmer_home"))

        return render_template("farmer/login.html", error=error)

    @app.route("/farmer/forgot-password", methods=["GET", "POST"])
    def farmer_forgot_password():
        """Send OTP via SMS Gateway to reset farmer password."""
        if is_farmer_authenticated():
            return redirect(url_for("farmer_home"))

        error = ""
        if request.method == "POST":
            ok_phone, phone_err, phone = validate_phone(request.form.get("phone", ""))
            if not ok_phone:
                error = phone_err
            else:
                farmer, lookup_err = lookup_farmer_by_phone(phone)
                if not farmer:
                    error = lookup_err or "Phone number not found."
                else:
                    code, otp_err = create_otp(
                        OTP_PURPOSE_FARMER,
                        phone,
                        subject_id=farmer["user_id"],
                    )
                    if otp_err:
                        error = otp_err
                    else:
                        sms = send_otp_sms(phone, code)
                        if not sms.ok:
                            error = sms.error or "Could not send SMS. Check SMS Gateway settings."
                        else:
                            session[OTP_SESSION_PHONE] = phone
                            session[OTP_SESSION_USER_ID] = farmer["user_id"]
                            try:
                                log_activity(
                                    phone,
                                    "FARMER_OTP_SENT",
                                    f"Password reset OTP via {sms.provider}",
                                    request.remote_addr,
                                )
                            except Exception:
                                pass
                            if sms.dev_message:
                                session["farmer_reset_dev_otp"] = sms.dev_message
                            else:
                                session.pop("farmer_reset_dev_otp", None)
                            # Prefer verify-reset-otp path; forgot-password-otp-sent.html is unused legacy.
                            return redirect(url_for("farmer_verify_reset_otp"))

        return render_template("farmer/forgot-password.html", error=error)

    @app.route("/farmer/verify-reset-otp", methods=["GET", "POST"])
    def farmer_verify_reset_otp():
        """Enter OTP from SMS and set a new password."""
        phone = session.get(OTP_SESSION_PHONE) or ""
        user_id = session.get(OTP_SESSION_USER_ID)
        if not phone:
            flash("Request a verification code first.", "error")
            return redirect(url_for("farmer_forgot_password"))

        error = ""
        dev_otp = session.get("farmer_reset_dev_otp")
        if request.method == "POST":
            otp = (request.form.get("otp") or "").strip()
            new_password = request.form.get("newPassword", "")
            confirm_password = request.form.get("confirmPassword", "")

            ok_pwd, pwd_err = validate_password(new_password, confirm_password)
            if not otp or len(otp) != 6 or not otp.isdigit():
                error = "Enter the 6-digit code from your SMS."
            elif not ok_pwd:
                error = pwd_err
            else:
                ok_otp, otp_err = verify_otp(OTP_PURPOSE_FARMER, phone, otp)
                if not ok_otp:
                    error = otp_err or "Invalid code."
                else:
                    from config.otp import consume_otp

                    consumed, consume_err, subject_id = consume_otp(OTP_PURPOSE_FARMER, phone, otp)
                    if not consumed:
                        error = consume_err or "Invalid code."
                    else:
                        uid = int(subject_id or user_id or 0)
                        updated, upd_err = update_farmer_password(uid, new_password)
                        if not updated:
                            error = upd_err or "Could not save new password."
                        else:
                            session.pop(OTP_SESSION_PHONE, None)
                            session.pop(OTP_SESSION_USER_ID, None)
                            session.pop("farmer_reset_dev_otp", None)
                            try:
                                log_activity(
                                    phone,
                                    "FARMER_PASSWORD_RESET",
                                    "Password reset via OTP",
                                    request.remote_addr,
                                )
                            except Exception:
                                pass
                            flash("Password updated. You can log in with your new password.", "success")
                            return redirect(url_for("farmer_login"))

        return render_template(
            "farmer/verify-reset-otp.html",
            phone_display=f"+63{phone}",
            error=error,
            dev_otp=dev_otp,
        )

    @app.route("/farmer/logout")
    def farmer_logout():
        phone = get_current_farmer_phone() or ""
        if phone:
            try:
                log_activity(phone, "FARMER_LOGOUT", "Farmer logged out", request.remote_addr)
            except Exception:
                pass
        session.pop("farmer_phone", None)
        session.pop("farmer_name", None)
        session.pop("farmer_id", None)
        return redirect(url_for("farmer_login"))

    @app.route("/farmer/home")
    def farmer_home():
        if not is_farmer_authenticated():
            return redirect(url_for("farmer_login"))
        return render_template(
            "farmer/home.html",
            farmer_phone=session.get("farmer_phone", ""),
            farmer_name=session.get("farmer_name", ""),
        )

    @app.route("/farmer/messages")
    def farmer_messages():
        if not is_farmer_authenticated():
            return redirect(url_for("farmer_login"))
        return render_template(
            "farmer/messages.html",
            farmer_phone=session.get("farmer_phone", ""),
            farmer_name=session.get("farmer_name", ""),
        )

    @app.route("/api/farmer/portal-status", methods=["GET"])
    def api_farmer_portal_status():
        if not is_farmer_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        phone = get_current_farmer_phone() or ""
        farmer_id = session.get("farmer_id")
        try:
            farmer_id = int(farmer_id) if farmer_id else None
        except (TypeError, ValueError):
            farmer_id = None
        if not farmer_id:
            try:
                farmer, _err = lookup_farmer_by_phone(phone)
                if farmer:
                    farmer_id = int(farmer.get("farmer_id") or 0) or None
                    session["farmer_id"] = farmer_id
            except Exception:
                farmer_id = None
        return jsonify(_portal_status_payload(farmer_id, phone))
