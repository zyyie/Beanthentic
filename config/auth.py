"""
Authentication routes for Beanthentic application.

Handles user signup, login, logout, and password reset functionality.
"""

from flask import flash, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from config.password_reset import consume_reset_token, create_password_reset, verify_reset_token
from config.sms import build_reset_url, send_password_reset_sms
from config.validation import validate_full_name, validate_password, validate_phone
from config.utils import (
    has_admin_account,
    load_users,
    log_activity,
    resolve_user_phone_key,
    save_users,
)

def register_auth_routes(app):
    """Register authentication routes with the Flask app."""

    @app.route("/")
    def home():
        """Home route - redirects based on authentication status."""
        if session.get("user_phone"):
            return redirect(url_for("dashboard"))
        if has_admin_account():
            return redirect(url_for("login"))
        return redirect(url_for("signup"))

    @app.route("/signup", methods=["GET", "POST"])
    def signup():
        """Handle user registration."""
        error = ""

        if request.method == "POST":
            full_name = request.form.get("fullName", "").strip()
            phone = request.form.get("phone", "").strip()
            password = request.form.get("password", "")
            confirm_password = request.form.get("confirmPassword", "")

            ok_name, name_err, full_name = validate_full_name(full_name)
            ok_phone, phone_err, phone = validate_phone(phone)
            ok_pwd, pwd_err = validate_password(password, confirm_password)

            if not ok_name:
                error = name_err
            elif not ok_phone:
                error = phone_err
            elif not ok_pwd:
                error = pwd_err
            else:
                users = load_users()
                if phone in users:
                    error = "Phone number is already registered."
                else:
                    users[phone] = {
                        "full_name": full_name,
                        "password_hash": generate_password_hash(password),
                    }
                    save_users(users)
                    return redirect(url_for("login"))

        return render_template(
            "admin/signup.html",
            error=error,
            registration_closed=False,
        )

    @app.route("/login", methods=["GET", "POST"])
    def login():
        """
        Handle user login.

        MOBILE APP CONNECTION:
        - Method: POST
        - Endpoint: /login
        - Payload (Form Data): phone (10 digits), password
        - Success: Sets a session cookie. The app MUST persist this cookie.
        """
        if not has_admin_account():
            return redirect(url_for("signup"))

        error = ""

        if request.method == "POST":
            phone = request.form.get("phone", "").strip()
            password = request.form.get("password", "")

            ok_phone, phone_err, phone = validate_phone(phone)
            if not ok_phone:
                error = phone_err
            elif not password:
                error = "Password is required."
            else:
                users = load_users()
                user_key = resolve_user_phone_key(users, phone)
                user = users.get(user_key) if user_key else None

                if not user or not check_password_hash(user.get("password_hash", ""), password):
                    error = "Invalid phone number or password."
                    log_activity(phone, "LOGIN_FAILED", "Failed login attempt", request.remote_addr)
                elif user.get("deactivated"):
                    error = "This account has been deactivated. Contact another administrator to restore access."
                    log_activity(user_key or phone, "LOGIN_BLOCKED", "Deactivated account sign-in attempt", request.remote_addr)
                else:
                    session.clear()
                    session["user_phone"] = user_key
                    session["user_name"] = user.get("full_name", "Admin")
                    log_activity(user_key, "LOGIN", "User logged in successfully", request.remote_addr)
                    return redirect(url_for("dashboard"))

        return render_template(
            "admin/login.html",
            error=error,
            signup_open=True,
        )

    @app.route("/forgot-password", methods=["GET", "POST"])
    def forgot_password():
        """Request a password reset link for a registered admin phone number."""
        if session.get("user_phone"):
            return redirect(url_for("dashboard"))

        error = ""

        if request.method == "POST":
            phone_raw = request.form.get("phone", "").strip()
            ok_phone, phone_err, phone = validate_phone(phone_raw)
            if not ok_phone:
                error = phone_err
            else:
                users = load_users()
                user_key = resolve_user_phone_key(users, phone)
                if not user_key:
                    error = "Phone number not found in our system."
                else:
                    token = create_password_reset(user_key)
                    reset_url = build_reset_url(
                        token,
                        request_base_url=request.url_root.rstrip("/"),
                    )
                    sms_result = send_password_reset_sms(phone, reset_url)
                    if not sms_result.ok:
                        log_activity(
                            user_key,
                            "PASSWORD_RESET_SMS_FAILED",
                            sms_result.error or "SMS send failed",
                            request.remote_addr,
                        )
                        error = sms_result.error or "Could not send SMS. Check SMS settings and try again."
                    else:
                        log_activity(
                            user_key,
                            "PASSWORD_RESET_REQUESTED",
                            f"Reset SMS sent via {sms_result.provider}",
                            request.remote_addr,
                        )
                        return render_template(
                            "admin/forgot-password-sent.html",
                            phone_display=f"+63{phone}",
                            dev_reset_link=sms_result.dev_message,
                        )

        return render_template("admin/forgot-password.html", error=error)

    @app.route("/reset-password/<token>", methods=["GET", "POST"])
    def reset_password(token):
        """Set a new password using a valid reset token."""
        if session.get("user_phone"):
            return redirect(url_for("dashboard"))

        phone_key = verify_reset_token(token)
        if not phone_key:
            return render_template(
                "admin/reset-password-expired.html",
                message="This reset link is invalid or has expired. Request a new one below.",
            )

        users = load_users()
        user = users.get(phone_key)
        if not user:
            consume_reset_token(token)
            return render_template(
                "admin/reset-password-expired.html",
                message="This account no longer exists. Contact an administrator.",
            )

        phone_suffix = phone_key[-4:] if len(phone_key) >= 4 else phone_key
        error = ""

        if request.method == "POST":
            new_password = request.form.get("newPassword", "")
            confirm_password = request.form.get("confirmPassword", "")
            ok_pwd, pwd_err = validate_password(new_password, confirm_password)
            if not ok_pwd:
                error = pwd_err
            else:
                confirmed_phone = consume_reset_token(token)
                if not confirmed_phone or confirmed_phone != phone_key:
                    return render_template(
                        "admin/reset-password-expired.html",
                        message="This reset link has already been used or has expired.",
                    )
                users = load_users()
                if phone_key not in users:
                    return render_template(
                        "admin/reset-password-expired.html",
                        message="This account no longer exists. Contact an administrator.",
                    )
                users[phone_key]["password_hash"] = generate_password_hash(new_password)
                save_users(users)
                log_activity(
                    phone_key,
                    "PASSWORD_RESET_COMPLETED",
                    "Password reset via forgot-password flow",
                    request.remote_addr,
                )
                flash("Your password has been updated. You can log in now.", "success")
                return redirect(url_for("login"))

        return render_template(
            "admin/reset-password.html",
            token=token,
            phone_suffix=phone_suffix,
            error=error,
        )

    @app.route("/logout")
    def logout():
        """Handle user logout."""
        user_phone = session.get("user_phone", "")
        if user_phone:
            log_activity(user_phone, "LOGOUT", "User logged out", request.remote_addr)
        session.clear()
        return redirect(url_for("login"))
