from __future__ import annotations

import base64
import json
import secrets
import time
from datetime import datetime
from pathlib import Path
import io

from flask import Flask, redirect, render_template, request, session, url_for, jsonify, send_file
from werkzeug.security import check_password_hash, generate_password_hash
from flask_admin import Admin, AdminIndexView
from flask_admin.contrib.sqla import ModelView
from flask_sqlalchemy import SQLAlchemy

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = "beanthentic-dev-secret-change-this"

class ProtectedAdminIndexView(AdminIndexView):
    def is_accessible(self):
        return bool(session.get("user_email"))

    def inaccessible_callback(self, name, **kwargs):
        return redirect(url_for("login"))


class ProtectedModelView(ModelView):
    def is_accessible(self):
        return bool(session.get("user_email"))

    def inaccessible_callback(self, name, **kwargs):
        return redirect(url_for("login"))


class FarmerModelView(ProtectedModelView):
    """Custom admin view for Farmer model with tabbed structure like the farmer's record table"""
    
    # Main table columns (like your image shows)
    column_list = ('no', 'last_name', 'first_name', 'address_barangay', 'birthday', 'remarks')
    column_labels = {
        'no': 'NO.',
        'last_name': 'LAST NAME',
        'first_name': 'FIRST NAME', 
        'address_barangay': 'ADDRESS (BARANGAY)',
        'birthday': 'BIRTHDAY',
        'remarks': 'REMARKS'
    }
    
    # Search and filter (using actual database columns)
    column_searchable_list = ['name', 'address_barangay']
    column_filters = ['address_barangay', 'rsbsa_registered']
    
    # Form organized in tabs like your interface (using actual database fields)
    form_columns = ('no', 'name', 'address_barangay', 'fa_officer_member', 'birthday',
                   'rsbsa_registered', 'status_ownership', 'total_area_planted_ha',
                   'liberica_bearing', 'liberica_non_bearing', 'excelsa_bearing',
                   'excelsa_non_bearing', 'robusta_bearing', 'robusta_non_bearing',
                   'total_bearing', 'total_non_bearing', 'total_trees',
                   'liberica_production', 'excelsa_production', 'robusta_production',
                   'ncfrs', 'remarks')
    
    # Pagination
    page_size = 50
    
    # Sort by NO. by default
    column_default_sort = 'no'
    
    # Custom templates - tabs only for edit/create, use default for list view
    edit_template = 'admin/edit_farmer.html'
    create_template = 'admin/create_farmer.html'
    
    def get_query(self):
        # Split the name field into last_name and first_name for display
        return super(FarmerModelView, self).get_query()
    
    def on_model_change(self, form, model, is_created):
        # Combine last_name and first_name into the name field
        if hasattr(form, 'last_name') and hasattr(form, 'first_name'):
            model.name = f"{form.last_name.data} {form.first_name.data}".strip()
        return super(FarmerModelView, self).on_model_change(form, model, is_created)
    
    def edit_form(self, obj=None):
        form = super(FarmerModelView, self).edit_form(obj=obj)
        # Split existing name into last_name and first_name
        if obj and obj.name:
            name_parts = obj.name.split(' ', 1)
            if hasattr(form, 'last_name'):
                form.last_name.data = name_parts[0] if len(name_parts) > 0 else ''
            if hasattr(form, 'first_name'):
                form.first_name.data = name_parts[1] if len(name_parts) > 1 else ''
        return form


# Initialize Flask-Admin interface (protected by session login)
admin = Admin(app, name="Beanthentic Admin", index_view=ProtectedAdminIndexView())

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

    @property
    def last_name(self):
        """Extract last name from the name field"""
        if self.name:
            name_parts = self.name.split(' ', 1)
            return name_parts[0] if len(name_parts) > 0 else ''
        return ''
    
    @property  
    def first_name(self):
        """Extract first name from the name field"""
        if self.name:
            name_parts = self.name.split(' ', 1)
            return name_parts[1] if len(name_parts) > 1 else ''
        return ''
    
    def __repr__(self):
        return f"Farmer('{self.name}', '{self.address_barangay}')"

# Add Farmer model to Flask-Admin interface with custom view
admin.add_view(FarmerModelView(Farmer, db.session, name='Farmer Records'))


class AdminUser(db.Model):
    __tablename__ = "admin_user"

    email = db.Column(db.String(255), primary_key=True)
    full_name = db.Column(db.String(255), nullable=False)
    password_hash = db.Column(db.String(512), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"AdminUser('{self.email}')"


class ActivityLogEntry(db.Model):
    __tablename__ = "activity_log_entry"

    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, nullable=False, index=True)
    user_email = db.Column(db.String(255), nullable=False, index=True)
    action = db.Column(db.String(80), nullable=False, index=True)
    details = db.Column(db.Text, default="")
    ip_address = db.Column(db.String(64), default="")

    def __repr__(self):
        return f"ActivityLogEntry('{self.action}', '{self.user_email}')"


# Add JSON-backed models to Flask-Admin interface
admin.add_view(ProtectedModelView(AdminUser, db.session))
admin.add_view(ProtectedModelView(ActivityLogEntry, db.session))


USER_DB = Path(__file__).resolve().parent / "users.json"
SETTINGS_DB = Path(__file__).resolve().parent / "settings.json"





def sync_users_json_to_db() -> None:
    """Upsert users.json into sqlite so Flask-Admin can display them."""
    users = load_users()
    if not isinstance(users, dict) or not users:
        return

    for email, info in users.items():
        if not email or not isinstance(info, dict):
            continue
        full_name = (info.get("full_name") or "").strip() or email
        pw_hash = (info.get("password_hash") or "").strip()
        if not pw_hash:
            continue

        existing = db.session.get(AdminUser, email)
        if existing:
            existing.full_name = full_name
            existing.password_hash = pw_hash
        else:
            db.session.add(AdminUser(email=email, full_name=full_name, password_hash=pw_hash))
    db.session.commit()




def load_users() -> dict:
    if not USER_DB.exists():
        return {}
    try:
        return json.loads(USER_DB.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_users(users: dict) -> None:
    USER_DB.write_text(json.dumps(users, indent=2), encoding="utf-8")
    # Keep sqlite in sync for Flask-Admin visibility.
    try:
        sync_users_json_to_db()
    except Exception:
        # Don't break app flow if DB sync fails.
        pass


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




def log_activity(user_email: str, action: str, details: str = "", ip_address: str = "") -> None:
    # Write directly to database for Flask-Admin visibility
    try:
        ts = datetime.now()
        db.session.add(
            ActivityLogEntry(
                timestamp=ts,
                user_email=user_email or "",
                action=action or "",
                details=details or "",
                ip_address=ip_address or "",
            )
        )
        db.session.commit()
    except Exception:
        pass


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
    # Get activity log from database instead of JSON
    activity_log_entries = ActivityLogEntry.query.order_by(ActivityLogEntry.timestamp.desc()).limit(1000).all()
    activity_log = [
        {
            "timestamp": entry.timestamp.isoformat(),
            "user_email": entry.user_email,
            "action": entry.action,
            "details": entry.details,
            "ip_address": entry.ip_address
        }
        for entry in activity_log_entries
    ]
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
    # Get activity log from database
    log_entries = ActivityLogEntry.query.order_by(ActivityLogEntry.timestamp.desc()).limit(50).all()
    recent = [
        {
            "timestamp": entry.timestamp.isoformat(),
            "user_email": entry.user_email,
            "action": entry.action,
            "details": entry.details,
            "ip_address": entry.ip_address
        }
        for entry in log_entries
    ]
    return jsonify({"items": recent})


@app.route("/api/farmer-data", methods=["GET"])
def api_farmer_data():
    """Provide farmer data for dashboard in the same format as the original JSON."""
    farmers = Farmer.query.order_by(Farmer.no.asc()).all()
    
    # Convert to the same format as the original JSON data
    farmer_data = []
    for farmer in farmers:
        farmer_record = {
            "NO.": farmer.no,
            "NAME OF FARMER": farmer.name,
            "ADDRESS (BARANGAY)": farmer.address_barangay,
            "FA OFFICER / MEMBER": farmer.fa_officer_member,
            "BIRTHDAY": farmer.birthday or "",
            "RSBSA Registered (Yes/No)": farmer.rsbsa_registered,
            "STATUS OF OWNERSHIP": farmer.status_ownership or "",
            "Total Area Planted (HA.)": farmer.total_area_planted_ha,
            "LIBERICA BEARING": farmer.liberica_bearing,
            "LIBERICA NON-BEARING": farmer.liberica_non_bearing,
            "EXCELSA BEARING": farmer.excelsa_bearing,
            "EXCELSA NON-BEARING": farmer.excelsa_non_bearing,
            "ROBUSTA BEARING": farmer.robusta_bearing,
            "ROBUSTA NON-BEARING": farmer.robusta_non_bearing,
            "TOTAL BEARING": farmer.total_bearing,
            "TOTAL NON-BEARING": farmer.total_non_bearing,
            "TOTAL TREES": farmer.total_trees,
            "LIBERICA PRODUCTION": farmer.liberica_production,
            "EXCELSA PRODUCTION": farmer.excelsa_production,
            "ROBUSTA PRODUCTION": farmer.robusta_production,
            "NCFRS": farmer.ncfrs or "",
            "REMARKS": farmer.remarks or ""
        }
        farmer_data.append(farmer_record)
    
    return jsonify(farmer_data)


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
    # Database is now the single source of truth - no more JSON syncing

if __name__ == "__main__":
    app.run(debug=True, port=5001)
