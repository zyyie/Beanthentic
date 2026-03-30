from __future__ import annotations

import base64
import json
import secrets
import time
from datetime import datetime
from pathlib import Path
import io
import ast

from flask import Flask, redirect, render_template, request, session, url_for, jsonify, send_file
from werkzeug.security import check_password_hash, generate_password_hash
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView
from flask_sqlalchemy import SQLAlchemy

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = "beanthentic-dev-secret-change-this"

# Initialize Flask-Admin interface
admin = Admin(app, name='Beanthentic Admin')

# SQLAlchemy configuration
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///beanthentic.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db = SQLAlchemy(app)

# Farmer model
class Farmer(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    no = db.Column(db.Integer, nullable=False)
    name = db.Column(db.String(200), nullable=False)
    address_barangay = db.Column(db.String(100), nullable=False)
    fa_officer_member = db.Column(db.String(50), nullable=False)
    birthday = db.Column(db.String(50))
    rsbsa_registered = db.Column(db.String(10), nullable=False)
    status_ownership = db.Column(db.String(10))
    total_area_planted_ha = db.Column(db.Float, nullable=False)
    liberica_bearing = db.Column(db.Integer, default=0)
    liberica_non_bearing = db.Column(db.Integer, default=0)
    excelsa_bearing = db.Column(db.Integer, default=0)
    excelsa_non_bearing = db.Column(db.Integer, default=0)
    robusta_bearing = db.Column(db.Integer, default=0)
    robusta_non_bearing = db.Column(db.Integer, default=0)
    total_bearing = db.Column(db.Integer, default=0)
    total_non_bearing = db.Column(db.Integer, default=0)
    total_trees = db.Column(db.Integer, default=0)
    liberica_production = db.Column(db.Float, default=0)
    excelsa_production = db.Column(db.Float, default=0)
    robusta_production = db.Column(db.Float, default=0)
    ncfrs = db.Column(db.String(50))
    remarks = db.Column(db.Text)

    def __repr__(self):
        return f"Farmer('{self.name}', '{self.address_barangay}')"

# Add Farmer model to Flask-Admin interface
admin.add_view(ModelView(Farmer, db.session))

# Function to populate database with existing farmer data
def populate_farmer_data():
    # Check if data already exists by trying to query
    try:
        Farmer.query.first()
        return  # Data already exists, exit
    except:
        pass  # Table doesn't exist yet, continue with population
    
    # Import farmer data from the JS file
    try:
        farmer_data_file = Path(__file__).resolve().parent / "data" / "farmer-data.js"
        if farmer_data_file.exists():
            content = farmer_data_file.read_text(encoding='utf-8')
            # Extract the JavaScript array
            start = content.find('[')
            end = content.rfind(']') + 1
            if start != -1 and end != 0:
                # Convert JS object notation to Python dict
                js_data = content[start:end]
                # Replace single quotes with double quotes for JSON parsing
                js_data = js_data.replace("'", '"')
                # Convert to Python list
                farmer_list = ast.literal_eval(js_data)
                
                for farmer_data in farmer_list:
                    farmer = Farmer(
                        no=farmer_data.get('NO.', 0),
                        name=farmer_data.get('NAME OF FARMER', ''),
                        address_barangay=farmer_data.get('ADDRESS (BARANGAY)', ''),
                        fa_officer_member=farmer_data.get('FA OFFICER / MEMBER', ''),
                        birthday=farmer_data.get('BIRTHDAY', ''),
                        rsbsa_registered=farmer_data.get('RSBSA Registered (Yes/No)', ''),
                        status_ownership=farmer_data.get('STATUS OF OWNERSHIP', ''),
                        total_area_planted_ha=farmer_data.get('Total Area Planted (HA.)', 0),
                        liberica_bearing=farmer_data.get('LIBERICA BEARING', 0),
                        liberica_non_bearing=farmer_data.get('LIBERICA NON-BEARING', 0),
                        excelsa_bearing=farmer_data.get('EXCELSA BEARING', 0),
                        excelsa_non_bearing=farmer_data.get('EXCELSA NON-BEARING', 0),
                        robusta_bearing=farmer_data.get('ROBUSTA BEARING', 0),
                        robusta_non_bearing=farmer_data.get('ROBUSTA NON-BEARING', 0),
                        total_bearing=farmer_data.get('TOTAL BEARING', 0),
                        total_non_bearing=farmer_data.get('TOTAL NON-BEARING', 0),
                        total_trees=farmer_data.get('TOTAL TREES', 0),
                        liberica_production=farmer_data.get('LIBERICA PRODUCTION', 0),
                        excelsa_production=farmer_data.get('EXCELSA PRODUCTION', 0),
                        robusta_production=farmer_data.get('ROBUSTA PRODUCTION', 0),
                        ncfrs=farmer_data.get('NCFRS', ''),
                        remarks=farmer_data.get('REMARKS', '')
                    )
                    db.session.add(farmer)
                db.session.commit()
                print(f"Successfully populated {len(farmer_list)} farmer records")
    except Exception as e:
        print(f"Error populating farmer data: {e}")

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


def has_admin_account() -> bool:
    """True if at least one admin user exists."""
    return bool(load_users())


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
                "in_app_security_breaches": True,
            },
            "security": {
                "two_factor_enabled": False,
                "two_factor_secret": None,
                "backup_codes": [],
            },
        }


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
    if has_admin_account():
        return redirect(url_for("login"))
    return redirect(url_for("signup"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
    error = ""

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
                return redirect(url_for("login"))

    return render_template("admin/signup.html", error=error)


@app.route("/login", methods=["GET", "POST"])
def login():
    if not has_admin_account():
        return redirect(url_for("signup"))

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
    email = session.get("user_email", "")
    users = load_users()
    user = users.get(email, {})
    full_name = user.get("full_name") or session.get("user_name") or email
    return render_template(
        "dashboard.html",
        user_email=email,
        user_full_name=full_name,
    )


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


@app.route("/settings/state", methods=["GET"])
def settings_state():
    if not session.get("user_email"):
        return jsonify({"error": "Unauthorized"}), 401

    settings = load_settings()
    user_email = session.get("user_email", "")
    users = load_users()
    user = users.get(user_email, {})
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
                "email": user_email,
                "full_name": user.get("full_name") or session.get("user_name", ""),
            },
        }
    )


@app.route("/api/activity-feed", methods=["GET"])
def api_activity_feed():
    """Recent account activity for the dashboard Notifications module (refresh)."""
    if not session.get("user_email"):
        return jsonify({"error": "Unauthorized"}), 401
    log = load_activity_log()
    if not isinstance(log, list):
        log = []
    # Newest entries are appended last in the file — take tail and reverse
    recent = log[-50:][::-1]
    return jsonify({"items": recent})


@app.route("/settings/security", methods=["POST"])
def settings_security():
    if not session.get("user_email"):
        return jsonify({"error": "Unauthorized"}), 401
    
    action = request.form.get("action")
    user_email = session.get("user_email")
    users = load_users()
    current_user = users.get(user_email, {})
    
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
            sec = settings.setdefault(
                "security",
                {
                    "two_factor_enabled": False,
                    "two_factor_secret": None,
                    "backup_codes": [],
                },
            )
            if sec.get("two_factor_enabled") and sec.get("two_factor_secret"):
                return jsonify(
                    {
                        "success": "2FA is already enabled",
                        "secret": sec["two_factor_secret"],
                        "backup_codes": sec.get("backup_codes", []),
                    }
                )

            # Base32 secret for Google Authenticator / RFC 6238 TOTP apps
            secret = base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")
            backup_codes = [secrets.token_hex(4).upper() for _ in range(10)]

            sec["two_factor_enabled"] = True
            sec["two_factor_secret"] = secret
            sec["backup_codes"] = backup_codes

            save_settings(settings)
            log_activity(user_email, "2FA_ENABLED", "Two-factor authentication enabled", request.remote_addr)
            return jsonify(
                {
                    "success": "2FA enabled successfully",
                    "secret": secret,
                    "backup_codes": backup_codes,
                }
            )
        else:
            # Require password confirmation to disable 2FA
            password = request.form.get("password")
            if not check_password_hash(current_user.get("password_hash", ""), password):
                return jsonify({"error": "Password is incorrect"})

            sec = settings.setdefault(
                "security",
                {
                    "two_factor_enabled": False,
                    "two_factor_secret": None,
                    "backup_codes": [],
                },
            )
            sec["two_factor_enabled"] = False
            sec["two_factor_secret"] = None
            sec["backup_codes"] = []
            
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
    
    # Get actual farmer data from database
    farmers = Farmer.query.all()
    
    # Create CSV content
    output = io.StringIO()
    output.write("NO.,NAME OF FARMER,ADDRESS (BARANGAY),FA OFFICER / MEMBER,BIRTHDAY,RSBSA Registered (Yes/No),STATUS OF OWNERSHIP,Total Area Planted (HA.),LIBERICA BEARING,LIBERICA NON-BEARING,EXCELSA BEARING,EXCELSA NON-BEARING,ROBUSTA BEARING,ROBUSTA NON-BEARING,TOTAL BEARING,TOTAL NON-BEARING,TOTAL TREES,LIBERICA PRODUCTION,EXCELSA PRODUCTION,ROBUSTA PRODUCTION,NCFRS,REMARKS\n")
    
    for farmer in farmers:
        output.write(f"{farmer.no},{farmer.name},{farmer.address_barangay},{farmer.fa_officer_member},{farmer.birthday},{farmer.rsbsa_registered},{farmer.status_ownership},{farmer.total_area_planted_ha},{farmer.liberica_bearing},{farmer.liberica_non_bearing},{farmer.excelsa_bearing},{farmer.excelsa_non_bearing},{farmer.robusta_bearing},{farmer.robusta_non_bearing},{farmer.total_bearing},{farmer.total_non_bearing},{farmer.total_trees},{farmer.liberica_production},{farmer.excelsa_production},{farmer.robusta_production},{farmer.ncfrs},{farmer.remarks}\n")
    
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
    
    # Get actual farmer data from database
    farmers = Farmer.query.all()
    total_farmers = len(farmers)
    total_area = sum(f.total_area_planted_ha for f in farmers)
    total_trees = sum(f.total_trees for f in farmers)
    
    # Create PDF content
    pdf_content = f"""
    Farmer Data Report
    Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    
    SUMMARY:
    - Total Farmers: {total_farmers}
    - Total Area Planted: {total_area:.2f} HA
    - Total Trees: {total_trees:,}
    
    DETAILED RECORDS:
    """
    
    for farmer in farmers[:20]:  # Limit to first 20 for readability
        pdf_content += f"""
    {farmer.no}. {farmer.name}
    Address: {farmer.address_barangay}
    FA Officer: {farmer.fa_officer_member}
    Area: {farmer.total_area_planted_ha} HA
    Trees: {farmer.total_trees:,}
    Production: Liberica={farmer.liberica_production}, Excelsa={farmer.excelsa_production}, Robusta={farmer.robusta_production}
    """
    
    if total_farmers > 20:
        pdf_content += f"\n... and {total_farmers - 20} more records"
    
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
    
    # Get actual farmer data from database
    farmers = Farmer.query.all()
    
    # Create CSV content
    output = io.StringIO()
    output.write("NO.,NAME OF FARMER,ADDRESS (BARANGAY),FA OFFICER / MEMBER,BIRTHDAY,RSBSA Registered (Yes/No),STATUS OF OWNERSHIP,Total Area Planted (HA.),LIBERICA BEARING,LIBERICA NON-BEARING,EXCELSA BEARING,EXCELSA NON-BEARING,ROBUSTA BEARING,ROBUSTA NON-BEARING,TOTAL BEARING,TOTAL NON-BEARING,TOTAL TREES,LIBERICA PRODUCTION,EXCELSA PRODUCTION,ROBUSTA PRODUCTION,NCFRS,REMARKS\n")
    
    for farmer in farmers:
        output.write(f"{farmer.no},{farmer.name},{farmer.address_barangay},{farmer.fa_officer_member},{farmer.birthday},{farmer.rsbsa_registered},{farmer.status_ownership},{farmer.total_area_planted_ha},{farmer.liberica_bearing},{farmer.liberica_non_bearing},{farmer.excelsa_bearing},{farmer.excelsa_non_bearing},{farmer.robusta_bearing},{farmer.robusta_non_bearing},{farmer.total_bearing},{farmer.total_non_bearing},{farmer.total_trees},{farmer.liberica_production},{farmer.excelsa_production},{farmer.robusta_production},{farmer.ncfrs},{farmer.remarks}\n")
    
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


# Create database tables and populate with data
with app.app_context():
    db.create_all()
    populate_farmer_data()

if __name__ == "__main__":
    app.run(debug=True, port=5001)
