from __future__ import annotations

import json
import secrets
import time
from datetime import datetime
from pathlib import Path
import io

from flask import Flask, redirect, render_template, request, session, url_for, jsonify, send_file
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = "beanthentic-dev-secret-change-this"

USER_DB = Path(__file__).resolve().parent / "users.json"
SETTINGS_DB = Path(__file__).resolve().parent / "settings.json"
ACTIVITY_LOG_DB = Path(__file__).resolve().parent / "activity_log.json"


def load_users() -> dict:
    if not USER_DB.exists():
        return {}
    try:
        return json.loads(USER_DB.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_users(users: dict) -> None:
    USER_DB.write_text(json.dumps(users, indent=2), encoding="utf-8")


def load_settings() -> dict:
    if not SETTINGS_DB.exists():
        return {
            "notifications": {
                "email_system_events": True,
                "email_user_registrations": True,
                "email_security_breaches": True,
                "sms_system_events": False,
                "sms_user_registrations": False,
                "sms_security_breaches": True,
                "in_app_system_events": True,
                "in_app_user_registrations": True,
                "in_app_security_breaches": True
            },
            "security": {
                "two_factor_enabled": False,
                "two_factor_secret": None,
                "backup_codes": []
            }
        }
    try:
        return json.loads(SETTINGS_DB.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_settings(settings: dict) -> None:
    SETTINGS_DB.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def load_activity_log() -> list:
    if not ACTIVITY_LOG_DB.exists():
        return []
    try:
        return json.loads(ACTIVITY_LOG_DB.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def save_activity_log(log: list) -> None:
    ACTIVITY_LOG_DB.write_text(json.dumps(log, indent=2), encoding="utf-8")


def log_activity(user_email: str, action: str, details: str = "", ip_address: str = "") -> None:
    log = load_activity_log()
    log.append({
        "timestamp": datetime.now().isoformat(),
        "user_email": user_email,
        "action": action,
        "details": details,
        "ip_address": ip_address
    })
    # Keep only last 1000 entries
    log = log[-1000:]
    save_activity_log(log)


@app.route("/")
def home():
    if session.get("user_email"):
        return redirect(url_for("dashboard"))
    return redirect(url_for("signup"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
    error = ""
    success = ""

    if request.method == "POST":
        full_name = request.form.get("fullName", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirmPassword", "")

        if not full_name or not email or not password or not confirm_password:
            error = "Please fill in all fields."
        elif password != confirm_password:
            error = "Passwords do not match."
        else:
            users = load_users()
            if email in users:
                error = "Email is already registered."
            else:
                users[email] = {
                    "full_name": full_name,
                    "password_hash": generate_password_hash(password),
                }
                save_users(users)
                success = "Signup successful. You can now log in."

    return render_template("admin/signup.html", error=error, success=success)


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""

    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        users = load_users()
        user = users.get(email)

        if not user or not check_password_hash(user.get("password_hash", ""), password):
            error = "Invalid email or password."
            log_activity(email, "LOGIN_FAILED", "Failed login attempt", request.remote_addr)
        else:
            session["user_email"] = email
            session["user_name"] = user.get("full_name", "Admin")
            log_activity(email, "LOGIN", "User logged in successfully", request.remote_addr)
            return redirect(url_for("dashboard"))

    return render_template("admin/login.html", error=error)


@app.route("/dashboard")
def dashboard():
    if not session.get("user_email"):
        return redirect(url_for("login"))
    return render_template("dashboard.html")


@app.route("/logout")
def logout():
    user_email = session.get("user_email", "")
    if user_email:
        log_activity(user_email, "LOGOUT", "User logged out", request.remote_addr)
    session.clear()
    return redirect(url_for("login"))


@app.route("/settings")
def settings():
    if not session.get("user_email"):
        return redirect(url_for("login"))
    
    settings_data = load_settings()
    activity_log = load_activity_log()
    users = load_users()
    current_user = users.get(session.get("user_email"), {})
    
    return render_template("admin/settings.html", 
                         settings=settings_data,
                         activity_log=activity_log,
                         current_user=current_user)


@app.route("/settings/security", methods=["POST"])
def settings_security():
    if not session.get("user_email"):
        return jsonify({"error": "Unauthorized"}), 401
    
    action = request.form.get("action")
    user_email = session.get("user_email")
    users = load_users()
    current_user = users.get(user_email, {})
    
    if action == "change_password":
        current_password = request.form.get("current_password")
        new_password = request.form.get("new_password")
        confirm_password = request.form.get("confirm_password")
        
        if not check_password_hash(current_user.get("password_hash", ""), current_password):
            log_activity(user_email, "PASSWORD_CHANGE_FAILED", "Incorrect current password", request.remote_addr)
            return jsonify({"error": "Current password is incorrect"})
        
        if new_password != confirm_password:
            return jsonify({"error": "New passwords do not match"})
        
        if len(new_password) < 8:
            return jsonify({"error": "Password must be at least 8 characters long"})
        
        users[user_email]["password_hash"] = generate_password_hash(new_password)
        save_users(users)
        log_activity(user_email, "PASSWORD_CHANGED", "Password successfully changed", request.remote_addr)
        return jsonify({"success": "Password updated successfully"})
    
    elif action == "toggle_2fa":
        settings = load_settings()
        enable_2fa = request.form.get("enable_2fa") == "true"
        
        if enable_2fa:
            # Generate 2FA secret
            secret = secrets.token_hex(16)
            backup_codes = [secrets.token_hex(4).upper() for _ in range(10)]
            
            settings["security"]["two_factor_enabled"] = True
            settings["security"]["two_factor_secret"] = secret
            settings["security"]["backup_codes"] = backup_codes
            
            save_settings(settings)
            log_activity(user_email, "2FA_ENABLED", "Two-factor authentication enabled", request.remote_addr)
            return jsonify({
                "success": "2FA enabled successfully",
                "secret": secret,
                "backup_codes": backup_codes
            })
        else:
            # Require password confirmation to disable 2FA
            password = request.form.get("password")
            if not check_password_hash(current_user.get("password_hash", ""), password):
                return jsonify({"error": "Password is incorrect"})
            
            settings["security"]["two_factor_enabled"] = False
            settings["security"]["two_factor_secret"] = None
            settings["security"]["backup_codes"] = []
            
            save_settings(settings)
            log_activity(user_email, "2FA_DISABLED", "Two-factor authentication disabled", request.remote_addr)
            return jsonify({"success": "2FA disabled successfully"})
    
    return jsonify({"error": "Invalid action"})


@app.route("/settings/notifications", methods=["POST"])
def settings_notifications():
    if not session.get("user_email"):
        return jsonify({"error": "Unauthorized"}), 401
    
    settings = load_settings()
    notifications = settings.get("notifications", {})
    
    # Update notification preferences
    for key in notifications.keys():
        notifications[key] = request.form.get(key) == "true"
    
    settings["notifications"] = notifications
    save_settings(settings)
    
    user_email = session.get("user_email")
    log_activity(user_email, "NOTIFICATIONS_UPDATED", "Notification preferences updated", request.remote_addr)
    
    return jsonify({"success": "Notification settings updated"})


@app.route("/settings/profile", methods=["POST"])
def settings_profile():
    if not session.get("user_email"):
        return jsonify({"error": "Unauthorized"}), 401
    
    user_email = session.get("user_email")
    full_name = request.form.get("full_name", "").strip()
    
    if not full_name:
        return jsonify({"error": "Full name is required"})
    
    users = load_users()
    users[user_email]["full_name"] = full_name
    save_users(users)
    
    session["user_name"] = full_name
    log_activity(user_email, "PROFILE_UPDATED", f"Profile updated: {full_name}", request.remote_addr)
    
    return jsonify({"success": "Profile updated successfully"})


# Export Routes
@app.route("/export/excel")
def export_excel():
    if not session.get("user_email"):
        return redirect(url_for("login"))
    
    # Create sample data for export
    data = [
        {"Name": "John Doe", "Email": "john@example.com", "Role": "Admin", "Status": "Active"},
        {"Name": "Jane Smith", "Email": "jane@example.com", "Role": "User", "Status": "Active"},
        {"Name": "Bob Johnson", "Email": "bob@example.com", "Role": "User", "Status": "Inactive"}
    ]
    
    # Create CSV content
    output = io.StringIO()
    output.write("Name,Email,Role,Status\n")
    for row in data:
        output.write(f"{row['Name']},{row['Email']},{row['Role']},{row['Status']}\n")
    
    # Create file in memory
    output.seek(0)
    mem = io.BytesIO()
    mem.write(output.getvalue().encode('utf-8'))
    mem.seek(0)
    
    return send_file(
        mem,
        as_attachment=True,
        download_name=f"farmer_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
        mimetype='text/csv'
    )


@app.route("/export/pdf")
def export_pdf():
    if not session.get("user_email"):
        return redirect(url_for("login"))
    
    # Create simple PDF content (as text for now)
    pdf_content = f"""
    Farmer Data Report
    Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    
    Sample Data:
    - John Doe (john@example.com) - Admin - Active
    - Jane Smith (jane@example.com) - User - Active  
    - Bob Johnson (bob@example.com) - User - Inactive
    
    Total Records: 3
    """
    
    # Create file in memory
    mem = io.BytesIO()
    mem.write(pdf_content.encode('utf-8'))
    mem.seek(0)
    
    return send_file(
        mem,
        as_attachment=True,
        download_name=f"farmer_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt",
        mimetype='text/plain'
    )


@app.route("/export/csv")
def export_csv():
    if not session.get("user_email"):
        return redirect(url_for("login"))
    
    # Create sample data for export
    data = [
        {"Name": "John Doe", "Email": "john@example.com", "Role": "Admin", "Status": "Active"},
        {"Name": "Jane Smith", "Email": "jane@example.com", "Role": "User", "Status": "Active"},
        {"Name": "Bob Johnson", "Email": "bob@example.com", "Role": "User", "Status": "Inactive"}
    ]
    
    # Create CSV content
    output = io.StringIO()
    output.write("Name,Email,Role,Status\n")
    for row in data:
        output.write(f"{row['Name']},{row['Email']},{row['Role']},{row['Status']}\n")
    
    # Create file in memory
    output.seek(0)
    mem = io.BytesIO()
    mem.write(output.getvalue().encode('utf-8'))
    mem.seek(0)
    
    return send_file(
        mem,
        as_attachment=True,
        download_name=f"farmer_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
        mimetype='text/csv'
    )


if __name__ == "__main__":
    app.run(debug=True, port=5001)
