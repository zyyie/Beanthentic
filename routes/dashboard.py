"""
Dashboard and settings routes for Beanthentic application.
"""

import os
from datetime import datetime

from flask import jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from config.models import ActivityLogEntry
from config.utils import (
    get_current_user_phone,
    is_authenticated,
    load_settings,
    load_users,
    log_activity,
    save_settings,
    save_users,
)


def register_dashboard_routes(app):
    """Register dashboard and settings routes with the Flask app."""

    @app.route("/dashboard")
    def dashboard():
        """Main dashboard page."""
        if not is_authenticated():
            return redirect(url_for("login"))
        phone = get_current_user_phone() or ""
        users = load_users()
        user = users.get(phone, {})
        full_name = user.get("full_name") or session.get("user_name") or phone
        google_maps_api_key = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
        return render_template(
            "templates/dashboard.html",
            user_phone=phone,
            user_full_name=full_name,
            google_maps_api_key=google_maps_api_key,
        )

    @app.route("/settings")
    def settings():
        """Settings page."""
        if not is_authenticated():
            return redirect(url_for("login"))

        settings_data = load_settings()
        # Get activity log from database instead of JSON
        activity_log_entries = ActivityLogEntry.query.order_by(ActivityLogEntry.timestamp.desc()).limit(1000).all()
        activity_log = [
            {
                "timestamp": entry.timestamp.isoformat(),
                "user_phone": entry.user_phone,
                "action": entry.action,
                "details": entry.details,
                "ip_address": entry.ip_address
            }
            for entry in activity_log_entries
        ]
        users = load_users()
        current_user = users.get(get_current_user_phone() or "", {})

        return render_template("admin/settings.html",
                             settings=settings_data,
                             activity_log=activity_log,
                             current_user=current_user)

    @app.route("/settings/state", methods=["GET"])
    def settings_state():
        """Get settings state for the settings page."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        settings = load_settings()
        user_phone = get_current_user_phone() or ""
        users = load_users()
        user = users.get(user_phone, {})
        notifications = settings.get("notifications", {})
        sec = settings.get("security", {})
        tf_enabled = bool(sec.get("two_factor_enabled"))

        return jsonify(
            {
                "notifications": notifications,
                "security": {
                    "two_factor_enabled": tf_enabled,
                    "totp_secret": (sec.get("two_factor_secret") if tf_enabled else None),
                    "backup_codes": (sec.get("backup_codes") if tf_enabled else None),
                },
                "user": {
                    "phone": user_phone,
                    "full_name": user.get("full_name") or session.get("user_name", ""),
                },
            }
        )

    @app.route("/api/activity-feed", methods=["GET"])
    def api_activity_feed():
        """Recent account activity for the dashboard Notifications module (refresh)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        # Get activity log from database
        log_entries = ActivityLogEntry.query.order_by(ActivityLogEntry.timestamp.desc()).limit(50).all()
        recent = [
            {
                "timestamp": entry.timestamp.isoformat(),
                "user_phone": entry.user_phone,
                "action": entry.action,
                "details": entry.details,
                "ip_address": entry.ip_address
            }
            for entry in log_entries
        ]
        return jsonify({"items": recent})

    @app.route("/api/admin-notifications", methods=["GET"])
    def api_admin_notifications():
        """Admin notifications summary for the dashboard."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        user_phone = get_current_user_phone()
        notifications = []
        now = datetime.now()

        # Recent activity notifications
        recent_activity = ActivityLogEntry.query.filter(
            ActivityLogEntry.timestamp > now.replace(hour=0, minute=0, second=0, microsecond=0)
        ).order_by(ActivityLogEntry.timestamp.desc()).limit(5).all()

        for activity in recent_activity:
            notifications.append(
                {
                    "id": f"activity-{activity.id}",
                    "title": f"Activity: {activity.action}",
                    "message": activity.details or activity.action,
                    "timestamp": activity.timestamp.isoformat(),
                    "type": "activity",
                    "read": False,
                }
            )

        # IPOPHL document notifications
        from config.models import DocumentAnalysis
        recent_docs = DocumentAnalysis.query.filter(
            DocumentAnalysis.upload_timestamp > now.replace(hour=0, minute=0, second=0, microsecond=0)
        ).order_by(DocumentAnalysis.upload_timestamp.desc()).limit(5).all()

        for doc in recent_docs:
            if doc.ai_score < 70:
                notifications.append(
                    {
                        "id": f"doc-{doc.file_uuid}",
                        "title": f"Document: {doc.original_filename}",
                        "message": f"Low readiness score: {doc.ai_score}%",
                        "timestamp": doc.upload_timestamp.isoformat(),
                        "type": "warning",
                        "read": False,
                    }
                )
            else:
                notifications.append(
                    {
                        "id": f"doc-{doc.file_uuid}",
                        "title": f"Document: {doc.original_filename}",
                        "message": f"Readiness score: {doc.ai_score}%",
                        "timestamp": doc.upload_timestamp.isoformat(),
                        "type": "success",
                        "read": False,
                    }
                )

        # If no notifications, add a welcome message
        if not notifications:
            notifications.append(
                {
                    "id": "welcome",
                    "title": "Welcome to Beanthentic",
                    "message": "Upload and analyze IPOPHL files to start readiness tracking.",
                    "meta": now.isoformat(),
                    "detail": "Upload and analyze IPOPHL files to start readiness tracking.",
                    "category": "ipophl-progress",
                    "category_label": "IPOPHL",
                    "read": False,
                }
            )

        notifications.sort(key=lambda item: item.get("meta", ""), reverse=True)
        return jsonify({"items": notifications})

    @app.route("/settings/security", methods=["POST"])
    def settings_security():
        """Handle security settings changes."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        action = request.form.get("action")
        user_phone = get_current_user_phone()
        users = load_users()
        current_user = users.get(user_phone, {})

        if action == "verify_current_password":
            attempt = request.form.get("current_password") or request.form.get("currentPassword") or ""
            if not attempt.strip():
                return jsonify({"valid": False, "error": "Enter your current password."})
            if check_password_hash(current_user.get("password_hash", ""), attempt):
                return jsonify({"valid": True})
            return jsonify({"valid": False, "error": "That doesn't match your current password."})

        if action == "change_password":
            current_password = request.form.get("current_password") or request.form.get("currentPassword")
            new_password = request.form.get("new_password") or request.form.get("newPassword")
            confirm_password = request.form.get("confirm_password") or request.form.get("confirmPassword")

            if not check_password_hash(current_user.get("password_hash", ""), current_password):
                log_activity(user_phone, "PASSWORD_CHANGE_FAILED", "Incorrect current password", request.remote_addr)
                return jsonify({"error": "Current password is incorrect"})

            if new_password != confirm_password:
                return jsonify({"error": "New passwords do not match"})

            if len(new_password) < 8:
                return jsonify({"error": "Password must be at least 8 characters long"})

            users[user_phone]["password_hash"] = generate_password_hash(new_password)
            save_users(users)
            log_activity(user_phone, "PASSWORD_CHANGED", "Password successfully changed", request.remote_addr)
            return jsonify({"success": "Password updated successfully"})

        elif action == "toggle_2fa":
            settings = load_settings()
            enable_2fa = request.form.get("enable_2fa") == "true"

            if enable_2fa:
                sec = settings.setdefault(
                    "security",
                    {
                        "two_factor_enabled": False,
                        "two_factor_secret": None,
                        "backup_codes": [],
                    },
                )
                sec["two_factor_enabled"] = True
                sec["two_factor_secret"] = "JBSWY3DPEHPK3PXP"  # Placeholder - in production, generate real secret
                sec["backup_codes"] = ["123456", "789012", "345678", "901234", "567890"]
            else:
                sec = settings.get("security", {})
                sec["two_factor_enabled"] = False
                sec["two_factor_secret"] = None
                sec["backup_codes"] = []

            save_settings(settings)
            log_activity(user_phone, "2FA_TOGGLED", f"2FA {'enabled' if enable_2fa else 'disabled'}", request.remote_addr)
            return jsonify({"success": "2FA settings updated"})

        return jsonify({"error": "Invalid action"}), 400

    @app.route("/settings/notifications", methods=["POST"])
    def settings_notifications():
        """Handle notification settings changes."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        settings = load_settings()
        notifications = settings.setdefault("notifications", {})

        # Update notification settings from form data
        for key in request.form:
            if key.startswith("email_") or key.startswith("sms_") or key.startswith("in_app_"):
                notifications[key] = request.form.get(key) == "true"

        save_settings(settings)
        user_phone = get_current_user_phone()
        log_activity(user_phone, "NOTIFICATIONS_UPDATED", "Notification settings updated", request.remote_addr)
        return jsonify({"success": "Notification settings updated"})

    @app.route("/settings/profile", methods=["POST"])
    def settings_profile():
        """Handle profile settings changes."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        full_name = request.form.get("full_name", "").strip()
        if not full_name:
            return jsonify({"error": "Full name is required"}), 400

        user_phone = get_current_user_phone()
        users = load_users()
        if user_phone in users:
            users[user_phone]["full_name"] = full_name
            save_users(users)

        session["user_name"] = full_name
        log_activity(user_phone, "PROFILE_UPDATED", f"Profile updated: {full_name}", request.remote_addr)

        return jsonify({"success": "Profile updated successfully"})
