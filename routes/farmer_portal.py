"""
Farmer portal routes.

Provides farmer login, OTP password reset, and messaging UI.
"""

from flask import flash, redirect, render_template, request, session, url_for

from config.farmer_auth import is_farmer_phone_registered, lookup_farmer_by_phone, update_farmer_password
from config.otp import OTP_PURPOSE_FARMER, create_otp, verify_otp
from config.sms import send_otp_sms
from config.validation import clean_text, validate_password, validate_phone
from config.utils import get_current_farmer_phone, is_farmer_authenticated, log_activity

OTP_SESSION_PHONE = "farmer_reset_phone"
OTP_SESSION_USER_ID = "farmer_reset_user_id"


def register_farmer_portal_routes(app):
    @app.route("/farmer/login", methods=["GET", "POST"])
    def farmer_login():
        error = ""
        if request.method == "POST":
            phone = (request.form.get("phone") or "").strip()
            name_raw = (request.form.get("name") or "").strip()

            ok_phone, phone_err, phone = validate_phone(phone)
            if not ok_phone:
                error = phone_err
            else:
                registered, reg_err = is_farmer_phone_registered(phone)
                if not registered:
                    error = reg_err or "Phone number is not registered."
                else:
                    try:
                        name = clean_text(name_raw, 120, "Name", allow_empty=True) or ""
                    except ValueError as exc:
                        error = str(exc)
                        name = ""
                    if not error:
                        session.clear()
                        session["farmer_phone"] = phone
                        session["farmer_name"] = name or f"Farmer +63{phone}"
                        try:
                            log_activity(phone, "FARMER_LOGIN", "Farmer logged in", request.remote_addr)
                        except Exception:
                            pass
                        return redirect(url_for("farmer_messages"))

        return render_template("farmer/login.html", error=error)

    @app.route("/farmer/forgot-password", methods=["GET", "POST"])
    def farmer_forgot_password():
        """Send OTP via SMS Gateway to reset farmer password."""
        if is_farmer_authenticated():
            return redirect(url_for("farmer_messages"))

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
                            return render_template(
                                "farmer/forgot-password-otp-sent.html",
                                phone_display=f"+63{phone}",
                                dev_otp=sms.dev_message,
                            )

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
        return redirect(url_for("farmer_login"))

    @app.route("/farmer/messages")
    def farmer_messages():
        if not is_farmer_authenticated():
            return redirect(url_for("farmer_login"))
        return render_template(
            "farmer/messages.html",
            farmer_phone=session.get("farmer_phone", ""),
            farmer_name=session.get("farmer_name", ""),
        )
