"""
Authentication routes for Beanthentic application.

Handles user signup, login, logout, and password reset functionality.
"""

from flask import redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from config.utils import (
    has_admin_account,
    load_users,
    log_activity,
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

            if not full_name or not phone or not password or not confirm_password:
                error = "Please fill in all fields."
            elif not phone.isdigit():
                error = "Phone number must contain only numbers."
            elif len(phone) != 10:
                error = "Phone number must be exactly 10 digits (e.g., 9123456789)."
            elif password != confirm_password:
                error = "Passwords do not match."
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

        return render_template("admin/signup.html", error=error)

    @app.route("/login", methods=["GET", "POST"])
    def login():
        """Handle user login."""
        if not has_admin_account():
            return redirect(url_for("signup"))

        error = ""

        if request.method == "POST":
            phone = request.form.get("phone", "").strip()
            password = request.form.get("password", "")

            # Validate phone number
            if not phone:
                error = "Phone number is required."
            elif not phone.isdigit():
                error = "Phone number must contain only numbers."
            elif len(phone) != 10:
                error = "Phone number must be exactly 10 digits (e.g., 9123456789)."
            else:
                users = load_users()
                user = users.get(phone)

                if not user or not check_password_hash(user.get("password_hash", ""), password):
                    error = "Invalid phone number or password."
                    log_activity(phone, "LOGIN_FAILED", "Failed login attempt", request.remote_addr)
                else:
                    session["user_phone"] = phone
                    session["user_name"] = user.get("full_name", "Admin")
                    log_activity(phone, "LOGIN", "User logged in successfully", request.remote_addr)
                    return redirect(url_for("dashboard"))

        return render_template("admin/login.html", error=error)

    @app.route("/forgot-password", methods=["GET", "POST"])
    def forgot_password():
        """Handle password reset requests."""
        error = ""
        success = ""

        if request.method == "POST":
            phone = request.form.get("phone", "").strip()

            # Validate phone number
            if not phone:
                error = "Phone number is required."
            elif not phone.isdigit():
                error = "Phone number must contain only numbers."
            elif len(phone) != 10:
                error = "Phone number must be exactly 10 digits (e.g., 9123456789)."
            else:
                users = load_users()
                user = users.get(phone)

                if not user:
                    error = "Phone number not found in our system."
                else:
                    # Log the password reset request
                    log_activity(phone, "PASSWORD_RESET_REQUESTED", "User requested password reset", request.remote_addr)

                    # For demo purposes, show a success message
                    # In a real application, you would send an SMS or email with reset instructions
                    success = f"Password reset instructions have been sent to +63{phone}. For demo: Your account exists and you can contact admin to reset password."

        return render_template("admin/forgot-password.html", error=error, success=success)

    @app.route("/logout")
    def logout():
        """Handle user logout."""
        user_phone = session.get("user_phone", "")
        if user_phone:
            log_activity(user_phone, "LOGOUT", "User logged out", request.remote_addr)
        session.clear()
        return redirect(url_for("login"))
