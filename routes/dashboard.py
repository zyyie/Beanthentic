"""
Dashboard and settings routes for Beanthentic application.
"""

import json
import os
import time
from datetime import datetime

from flask import jsonify, redirect, render_template, request, send_file, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from config.models import ActivityLogEntry
from config.google_maps import get_google_maps_api_key, google_maps_key_is_production
from config.profile_photo import (
    migrate_profile_photo_key,
    profile_photo_file,
    profile_photo_url,
    save_profile_photo,
)
from config.validation import (
    ALLOWED_PROFILE_PHOTO_EXTENSIONS,
    validate_full_name,
    validate_password,
    validate_phone,
    validate_profile_photo_upload,
)
from config.utils import (
    get_current_admin_account,
    get_current_user_phone,
    is_authenticated,
    load_settings,
    load_users,
    log_activity,
    resolve_user_phone_key,
    save_settings,
    save_users,
)


def register_dashboard_routes(app):
    """Register dashboard and settings routes with the Flask app."""
    @app.route("/dashboard")
    def dashboard():
        """Main dashboard page (admin only)."""
        if not is_authenticated():
            return redirect(url_for("login"))

        phone = get_current_user_phone() or ""
        users = load_users()
        user = users.get(phone, {})
        full_name = user.get("full_name") or session.get("user_name") or phone
        google_maps_api_key = get_google_maps_api_key()
        return render_template(
            "templates/dashboard.html",
            user_phone=phone,
            user_full_name=full_name,
            google_maps_api_key=google_maps_api_key,
            google_maps_key_is_production=google_maps_key_is_production(google_maps_api_key),
            static_cache_bust=int(time.time()),
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
        account = get_current_admin_account()
        user = account["user"]
        notifications = settings.get("notifications", {})
        sec = settings.get("security", {})
        tf_enabled = bool(sec.get("two_factor_enabled"))
        storage_phone = (
            account["storage_phone"]
            or account["display_phone"]
            or account["phone_key"]
            or (get_current_user_phone() or "")
        ).strip()
        app_cfg = settings.get("app") if isinstance(settings.get("app"), dict) else {}

        photo_url = profile_photo_url(storage_phone) if storage_phone else None
        return jsonify(
            {
                "notifications": notifications,
                "security": {
                    "two_factor_enabled": tf_enabled,
                },
                "app": {
                    "version": str(app_cfg.get("version") or "1.0.0"),
                    "release_label": str(app_cfg.get("release_label") or ""),
                },
                "user": {
                    "phone": account["display_phone"],
                    "full_name": account["full_name"],
                    "first_name": account["first_name"],
                    "last_name": account["last_name"],
                    "profile_photo_url": photo_url,
                    "deactivated": bool(user.get("deactivated")),
                },
            }
        )

    @app.route("/api/app/version", methods=["GET"])
    def api_app_version():
        """Current app version (for Account → Check for updates)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        settings = load_settings()
        app_cfg = settings.get("app") if isinstance(settings.get("app"), dict) else {}
        version = str(app_cfg.get("version") or "1.0.0").strip()
        release_label = str(app_cfg.get("release_label") or "").strip()
        remote_url = str(app_cfg.get("update_check_url") or "").strip()

        latest_version = version
        update_available = False
        release_notes = ""

        if remote_url.startswith(("http://", "https://")):
            try:
                import urllib.request

                with urllib.request.urlopen(remote_url, timeout=8) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                if isinstance(payload, dict):
                    latest_version = str(payload.get("version") or latest_version).strip()
                    release_notes = str(payload.get("notes") or payload.get("message") or "").strip()
                    update_available = latest_version != version
            except Exception:
                pass

        return jsonify(
            {
                "version": version,
                "latest_version": latest_version,
                "release_label": release_label,
                "update_available": update_available,
                "release_notes": release_notes,
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
        """In-app admin notifications (messages, transactions, moderation, registrations, etc.)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        from config.admin_notifications import build_admin_notifications

        user_phone = get_current_user_phone()
        items: list = []
        try:
            items = build_admin_notifications(admin_phone=user_phone)
        except Exception:
            items = []

        return jsonify({"ok": True, "items": items, "count": len(items)})

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

            ok_pwd, pwd_err = validate_password(new_password, confirm_password)
            if not ok_pwd:
                return jsonify({"error": pwd_err})

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

        allowed_keys = {
            "email_system_events",
            "email_user_registrations",
            "email_security_breaches",
            "sms_system_events",
            "sms_user_registrations",
            "sms_security_breaches",
            "in_app_system_events",
            "in_app_user_registrations",
            "in_app_security_breaches",
        }
        for key in request.form:
            if key in allowed_keys:
                notifications[key] = request.form.get(key) == "true"

        save_settings(settings)
        user_phone = get_current_user_phone()
        log_activity(user_phone, "NOTIFICATIONS_UPDATED", "Notification settings updated", request.remote_addr)
        return jsonify({"success": "Notification settings updated"})

    @app.route("/settings/profile", methods=["POST"])
    def settings_profile():
        """Handle profile settings changes and profile photo uploads."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        action = (request.form.get("action") or "").strip().lower()
        if action == "upload_profile_photo":
            return _upload_profile_photo()

        photo_file = request.files.get("photo")
        if photo_file and (
            (photo_file.filename or "").strip()
            or (photo_file.mimetype or "").lower().startswith("image/")
        ):
            return _upload_profile_photo()

        first_name = (request.form.get("first_name") or "").strip()
        last_name = (request.form.get("last_name") or "").strip()
        raw_name = request.form.get("full_name") or request.form.get("fullName") or ""
        combined = f"{first_name} {last_name}".strip() or raw_name.strip()
        ok_name, name_err, full_name = validate_full_name(combined)
        if not ok_name:
            return jsonify({"error": name_err}), 400

        account = get_current_admin_account()
        users = load_users()
        user_phone = account["phone_key"]
        if not account["has_users_record"]:
            return jsonify(
                {
                    "error": "Account record is missing. Sign out and sign in again, or contact an administrator.",
                }
            ), 404

        phone_in = (request.form.get("phone") or "").strip()
        new_phone = account["storage_phone"] or user_phone
        if phone_in:
            ok_phone, phone_err, new_phone = validate_phone(phone_in)
            if not ok_phone:
                return jsonify({"error": phone_err}), 400

        resolved_current = resolve_user_phone_key(users, user_phone) or user_phone
        if new_phone != resolved_current and new_phone != account["storage_phone"]:
            if new_phone in users or resolve_user_phone_key(users, new_phone):
                return jsonify({"error": "Phone number is already registered."}), 400
            record = users.pop(resolved_current, users.get(user_phone, {}))
            users[new_phone] = record
            migrate_profile_photo_key(resolved_current, new_phone)
            user_phone = new_phone
            session["user_phone"] = new_phone
        else:
            user_phone = resolved_current

        user = users[user_phone]
        user["full_name"] = full_name
        user["first_name"] = first_name or full_name.split(None, 1)[0]
        user["last_name"] = last_name or (
            full_name.split(None, 1)[1] if len(full_name.split(None, 1)) > 1 else ""
        )
        save_users(users)

        session["user_name"] = full_name
        log_activity(user_phone, "PROFILE_UPDATED", f"Profile updated: {full_name}", request.remote_addr)

        return jsonify(
            {
                "success": "Profile updated successfully",
                "user": {
                    "phone": user_phone,
                    "full_name": full_name,
                    "first_name": user.get("first_name", ""),
                    "last_name": user.get("last_name", ""),
                },
            }
        )

    def _uploaded_photo_size(file) -> int:
        """Return upload size; camera captures often report 0 until the stream is read."""
        try:
            stream = getattr(file, "stream", None) or file
            pos = stream.tell()
            stream.seek(0, 2)
            size = int(stream.tell())
            stream.seek(0)
            if size > 0:
                return size
        except Exception:
            pass
        try:
            pos = file.tell()
        except Exception:
            pos = 0
        try:
            data = file.read()
            try:
                file.seek(pos)
            except Exception:
                try:
                    file.stream.seek(pos)
                except Exception:
                    pass
            if data:
                return len(data)
        except Exception:
            pass
        return int(request.content_length or 0)

    def _infer_profile_photo_ext(file) -> str:
        name = (file.filename or "").strip()
        if name and "." in name:
            from pathlib import Path

            ext = Path(name).suffix.lower()
            if ext in ALLOWED_PROFILE_PHOTO_EXTENSIONS:
                return ext
        mime = (file.mimetype or "").lower().split(";")[0].strip()
        mime_map = {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
            "image/gif": ".gif",
        }
        return mime_map.get(mime, ".jpg")

    def _serve_profile_photo():
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        account = get_current_admin_account()
        storage_phone = (
            account["storage_phone"]
            or account["display_phone"]
            or account["phone_key"]
            or (get_current_user_phone() or "")
        ).strip()
        path = profile_photo_file(storage_phone)
        if not path:
            return jsonify({"error": "No profile photo"}), 404

        return send_file(path, mimetype=None, conditional=True)

    def _upload_profile_photo():
        """Upload or replace profile photo (multipart field: photo)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        account = get_current_admin_account()
        storage_phone = (
            account["storage_phone"]
            or account["display_phone"]
            or account["phone_key"]
            or (get_current_user_phone() or "")
        ).strip()
        if not storage_phone:
            return jsonify({"error": "Not signed in."}), 401

        file = request.files.get("photo")
        if not file or not (
            (file.filename or "").strip()
            or (file.mimetype or "").lower().startswith("image/")
        ):
            return jsonify({"error": "Choose a photo to upload."}), 400

        size = _uploaded_photo_size(file)
        ext = _infer_profile_photo_ext(file)
        raw_name = (file.filename or "").strip()
        validate_name = raw_name if raw_name.lower().endswith(tuple(ALLOWED_PROFILE_PHOTO_EXTENSIONS)) else f"profile{ext}"

        ok, err, ext = validate_profile_photo_upload(validate_name, size)
        if not ok:
            return jsonify({"error": err}), 400

        try:
            save_profile_photo(storage_phone, file, ext=ext)
        except Exception as exc:
            return jsonify({"error": f"Could not save photo: {exc}"}), 500

        log_activity(
            account["phone_key"] or storage_phone,
            "PROFILE_PHOTO_UPDATED",
            "Profile photo updated",
            request.remote_addr,
        )
        return jsonify(
            {
                "success": "Profile photo updated.",
                "profile_photo_url": profile_photo_url(storage_phone),
            }
        )

    @app.route("/settings/profile-photo", methods=["GET", "POST"])
    @app.route("/api/admin-profile-photo", methods=["GET", "POST"])
    def admin_profile_photo():
        if request.method == "GET":
            return _serve_profile_photo()
        return _upload_profile_photo()

    @app.route("/api/admin-account/deactivate", methods=["POST"])
    def api_admin_account_deactivate():
        """Deactivate the current admin account (requires password confirmation)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        account = get_current_admin_account()
        users = load_users()
        user_phone = account["phone_key"]
        user = account["user"]
        if not user:
            return jsonify({"error": "Account not found"}), 404

        if user.get("deactivated"):
            return jsonify({"error": "This account is already deactivated."}), 400

        password = (request.form.get("password") or "").strip()
        if not password:
            return jsonify({"error": "Enter your password to confirm deactivation."}), 400

        if not check_password_hash(user.get("password_hash", ""), password):
            log_activity(user_phone, "ACCOUNT_DEACTIVATE_FAILED", "Wrong password", request.remote_addr)
            return jsonify({"error": "Password is incorrect."}), 403

        user["deactivated"] = True
        user["deactivated_at"] = datetime.utcnow().isoformat(timespec="seconds")
        save_users(users)
        log_activity(user_phone, "ACCOUNT_DEACTIVATED", "Admin deactivated own account", request.remote_addr)

        session.clear()
        return jsonify({"success": "Account deactivated. You have been signed out.", "redirect": url_for("login")})
