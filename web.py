from __future__ import annotations

from collections import defaultdict

import base64
import json
import os
import secrets
import time
from datetime import datetime
from pathlib import Path
import io
from werkzeug.utils import secure_filename

from flask import Flask, redirect, render_template, request, session, url_for, jsonify, send_file
from werkzeug.security import check_password_hash, generate_password_hash
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import text
from decimal import Decimal, InvalidOperation

from config.models import (db, Farmer, AdminUser, ActivityLogEntry,
                    Affiliation, FarmInfo, TreeCounts, Production, DocumentAnalysis,
                    FarmerCoffeeTransaction)

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = "beanthentic-dev-secret-change-this"

# Simple Flask app - no admin interface

# SQLAlchemy configuration
# Priority:
# 1) DATABASE_URL env var (full SQLAlchemy URL)
# 2) MySQL from env vars (MYSQL_USER/MYSQL_PASSWORD/MYSQL_HOST/MYSQL_DB)
# 3) Local SQLite fallback for easy local startup
database_url = os.getenv("DATABASE_URL", "").strip()
if not database_url:
    mysql_user = os.getenv("MYSQL_USER", "").strip()
    mysql_password = os.getenv("MYSQL_PASSWORD", "")
    mysql_host = os.getenv("MYSQL_HOST", "localhost").strip()
    mysql_db = os.getenv("MYSQL_DB", "beanthentic_records").strip()
    if mysql_user:
        database_url = f"mysql+pymysql://{mysql_user}:{mysql_password}@{mysql_host}/{mysql_db}"
    else:
        sqlite_path = Path(__file__).resolve().parent / "data" / "beanthentic.db"
        database_url = f"sqlite:///{sqlite_path.as_posix()}"

app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db.init_app(app)

# Database models initialized


USER_DB = Path(__file__).resolve().parent / "data" / "users.json"
SETTINGS_DB = Path(__file__).resolve().parent / "settings.json"





def sync_users_json_to_db() -> None:
    """Upsert users.json into sqlite so Flask-Admin can display them."""
    users = load_users()
    if not isinstance(users, dict) or not users:
        return

    for phone, info in users.items():
        if not phone or not isinstance(info, dict):
            continue
        full_name = (info.get("full_name") or "").strip() or phone
        pw_hash = (info.get("password_hash") or "").strip()
        if not pw_hash:
            continue

        existing = db.session.get(AdminUser, phone)
        if existing:
            existing.full_name = full_name
            existing.password_hash = pw_hash
        else:
            db.session.add(AdminUser(phone_number=phone, full_name=full_name, password_hash=pw_hash))
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
    # First check if there are users in the database
    try:
        admin_count = AdminUser.query.count()
        if admin_count > 0:
            return True
    except Exception:
        pass
    
    # Fallback to checking JSON file
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




def log_activity(user_phone: str, action: str, details: str = "", ip_address: str = "") -> None:
    # Write directly to database for Flask-Admin visibility
    try:
        ts = datetime.now()
        db.session.add(
            ActivityLogEntry(
                timestamp=ts,
                user_phone=user_phone or "",
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
    if session.get("user_phone"):
        return redirect(url_for("dashboard"))
    if has_admin_account():
        return redirect(url_for("login"))
    return redirect(url_for("signup"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
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
                
                # You could also generate a reset token and store it temporarily
                # For now, we'll just show a success message

    return render_template("admin/forgot-password.html", error=error, success=success)


@app.route("/dashboard")
def dashboard():
    if not session.get("user_phone"):
        return redirect(url_for("login"))
    phone = session.get("user_phone", "")
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


@app.route("/logout")
def logout():
    user_phone = session.get("user_phone", "")
    if user_phone:
        log_activity(user_phone, "LOGOUT", "User logged out", request.remote_addr)
    session.clear()
    return redirect(url_for("login"))


@app.route("/settings")
def settings():
    if not session.get("user_phone"):
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
    current_user = users.get(session.get("user_phone"), {})
    
    return render_template("admin/settings.html", 
                         settings=settings_data,
                         activity_log=activity_log,
                         current_user=current_user)


@app.route("/settings/state", methods=["GET"])
def settings_state():
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401

    settings = load_settings()
    user_phone = session.get("user_phone", "")
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
    if not session.get("user_phone"):
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


_ALLOWED_COFFEE_VARIETIES = frozenset({"liberica", "excelsa", "robusta"})


def _normalize_coffee_variety(raw: str | None) -> str | None:
    if not raw:
        return None
    v = str(raw).strip().lower()
    return v if v in _ALLOWED_COFFEE_VARIETIES else None


def _production_baseline_by_farmer() -> dict[int, dict[str, float]]:
    """Harvest baseline (kg) per farmer from Production; current stock starts here before ledger deltas."""
    out: dict[int, dict[str, float]] = defaultdict(
        lambda: {"liberica": 0.0, "excelsa": 0.0, "robusta": 0.0}
    )
    for prod in Production.query.all():
        out[prod.farmer_id] = {
            "liberica": float(prod.liberica_kg or 0),
            "excelsa": float(prod.excelsa_kg or 0),
            "robusta": float(prod.robusta_kg or 0),
        }
    return out


def _coffee_balance_after_by_txn_id() -> dict[int, float]:
    """Run full ledger in time order; map each transaction id -> stock (kg) for that row's variety after applying it."""
    baselines = _production_baseline_by_farmer()
    state: dict[int, dict[str, float]] = {}
    for fid, base in baselines.items():
        state[fid] = dict(base)

    txs = (
        FarmerCoffeeTransaction.query.order_by(
            FarmerCoffeeTransaction.recorded_at.asc(),
            FarmerCoffeeTransaction.id.asc(),
        ).all()
    )
    after: dict[int, float] = {}
    for tx in txs:
        fid = tx.farmer_id
        v = _normalize_coffee_variety(tx.variety)
        if v is None:
            continue
        if fid not in state:
            state[fid] = {"liberica": 0.0, "excelsa": 0.0, "robusta": 0.0}
        state[fid][v] = state[fid][v] + float(tx.delta_kg or 0)
        after[tx.id] = state[fid][v]
    return after


@app.route("/api/farmer-picker", methods=["GET"])
def api_farmer_picker():
    """Minimal farmer list for admin selects (coffee transactions, etc.)."""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    farmers = Farmer.query.order_by(Farmer.no.asc()).all()
    items = [
        {"id": f.id, "no": f.no, "name": f.name or ""}
        for f in farmers
    ]
    return jsonify({"items": items})


@app.route("/api/farmer-coffee-transactions", methods=["GET", "POST"])
def api_farmer_coffee_transactions():
    """List or create farmer coffee bean kg ledger entries (admin Transactions module)."""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401

    if request.method == "GET":
        limit = request.args.get("limit", type=int) or 400
        limit = min(max(limit, 1), 800)
        farmer_id = request.args.get("farmer_id", type=int)

        balance_after = _coffee_balance_after_by_txn_id()

        q = FarmerCoffeeTransaction.query
        if farmer_id:
            q = q.filter(FarmerCoffeeTransaction.farmer_id == farmer_id)
        rows = (
            q.order_by(
                FarmerCoffeeTransaction.recorded_at.desc(),
                FarmerCoffeeTransaction.id.desc(),
            )
            .limit(limit)
            .all()
        )

        farmer_cache: dict[int, Farmer] = {}
        items = []
        for tx in rows:
            f = farmer_cache.get(tx.farmer_id)
            if f is None:
                f = db.session.get(Farmer, tx.farmer_id)
                if f:
                    farmer_cache[tx.farmer_id] = f
            v = _normalize_coffee_variety(tx.variety) or (tx.variety or "").lower()
            items.append(
                {
                    "id": tx.id,
                    "farmer_id": tx.farmer_id,
                    "farmer_no": f.no if f else None,
                    "farmer_name": f.name if f else "",
                    "recorded_at": tx.recorded_at.isoformat() if tx.recorded_at else "",
                    "variety": v,
                    "delta_kg": float(tx.delta_kg or 0),
                    "balance_after_kg": balance_after.get(tx.id),
                    "buyer_name": (tx.buyer_name or "").strip(),
                    "notes": (tx.notes or "").strip(),
                    "recorded_by_phone": (tx.recorded_by_phone or "").strip(),
                }
            )
        return jsonify({"items": items})

    # POST — record movement (negative delta = sale / stock out)
    payload = request.get_json(silent=True) or {}
    farmer_id_val = payload.get("farmer_id")
    try:
        farmer_id_val = int(farmer_id_val)
    except (TypeError, ValueError):
        return jsonify({"error": "farmer_id is required"}), 400

    farmer = db.session.get(Farmer, farmer_id_val)
    if not farmer:
        return jsonify({"error": "Farmer not found"}), 404

    variety = _normalize_coffee_variety(payload.get("variety"))
    if not variety:
        return jsonify({"error": "variety must be liberica, excelsa, or robusta"}), 400

    try:
        delta_kg = Decimal(str(payload.get("delta_kg")))
    except (InvalidOperation, TypeError, ValueError):
        return jsonify({"error": "delta_kg must be a number"}), 400

    if delta_kg == 0:
        return jsonify({"error": "delta_kg cannot be zero"}), 400

    buyer = (payload.get("buyer_name") or "").strip()[:200]
    notes = (payload.get("notes") or "").strip()
    user_phone = session.get("user_phone") or ""

    tx = FarmerCoffeeTransaction(
        farmer_id=farmer_id_val,
        recorded_at=datetime.utcnow(),
        variety=variety,
        delta_kg=delta_kg,
        buyer_name=buyer,
        notes=notes,
        recorded_by_phone=user_phone,
    )
    db.session.add(tx)
    db.session.commit()

    sign_word = "Sale / out" if delta_kg < 0 else "Addition"
    log_activity(
        user_phone,
        "COFFEE_BEAN_TX",
        f"{sign_word}: {abs(delta_kg)} kg {variety} — {farmer.name} (No. {farmer.no})"
        + (f" — buyer: {buyer}" if buyer else ""),
        request.remote_addr,
    )

    return jsonify({"success": True, "id": tx.id})


@app.route("/api/admin-notifications", methods=["GET"])
def api_admin_notifications():
    """Admin notification feed for dashboard bell and notifications module."""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401

    now = datetime.utcnow()
    notifications = []

    # 1) Farmer coffee bean movements (sales / adjustments) recorded by admin.
    coffee_rows = (
        FarmerCoffeeTransaction.query.order_by(
            FarmerCoffeeTransaction.recorded_at.desc(),
            FarmerCoffeeTransaction.id.desc(),
        )
        .limit(15)
        .all()
    )
    for tx in coffee_rows:
        farmer = db.session.get(Farmer, tx.farmer_id)
        fname = farmer.name if farmer else "Farmer"
        fno = farmer.no if farmer else ""
        v = _normalize_coffee_variety(tx.variety) or (tx.variety or "").lower()
        kg = float(tx.delta_kg or 0)
        buyer = (tx.buyer_name or "").strip()
        if kg < 0:
            title = f"Bean sale: {abs(kg):,.2f} kg {v.title()}"
            detail = f"{fname} (No. {fno}) — stock reduced."
        else:
            title = f"Bean addition: {kg:,.2f} kg {v.title()}"
            detail = f"{fname} (No. {fno}) — stock increased."
        if buyer:
            detail += f" Buyer: {buyer}."
        notes = (tx.notes or "").strip()
        if notes:
            detail += f" {notes}"
        notifications.append(
            {
                "id": f"coffee-tx-{tx.id}",
                "icon": "fa-handshake",
                "title": title,
                "meta": (tx.recorded_at.isoformat() if tx.recorded_at else now.isoformat()),
                "detail": detail.strip(),
                "category": "transactions",
                "category_label": "Coffee beans",
                "read": False,
            }
        )

    # 2) Pending farmer registrations inferred from remarks/status notes.
    pending_keywords = (
        "pending",
        "for approval",
        "for review",
        "submission",
        "submitted",
        "new registration",
    )
    farmers = Farmer.query.order_by(Farmer.no.asc()).all()
    pending_farmers = []
    for farmer in farmers:
        remark = (farmer.remarks or "").strip().lower()
        if not remark:
            continue
        if any(token in remark for token in pending_keywords):
            pending_farmers.append(farmer)

    if pending_farmers:
        preview_names = ", ".join(
            [f.name for f in pending_farmers[:3] if getattr(f, "name", "").strip()]
        )
        more_count = max(len(pending_farmers) - 3, 0)
        suffix = f" and {more_count} more" if more_count else ""
        notifications.append(
            {
                "id": "pending-farmer-registrations",
                "icon": "fa-user-clock",
                "title": f"{len(pending_farmers)} pending farmer registration submission(s)",
                "meta": now.isoformat(),
                "detail": (
                    f"Review farmer records marked pending in remarks. "
                    f"Examples: {preview_names}{suffix}."
                ),
                "category": "pending-registrations",
                "category_label": "Farmer Registration",
                "read": False,
            }
        )

    # 3) Current IPOPHL progress snapshot from analyzed documents.
    ipo_docs = DocumentAnalysis.query.order_by(DocumentAnalysis.upload_timestamp.desc()).all()
    if ipo_docs:
        total_docs = len(ipo_docs)
        avg_score = round(sum((doc.ai_score or 0) for doc in ipo_docs) / total_docs)
        ready_docs = sum(
            1
            for doc in ipo_docs
            if str(doc.ai_status or "").strip().lower() in {"ready", "registration ready"}
        )
        latest_doc = ipo_docs[0]
        notifications.append(
            {
                "id": "ipophl-progress",
                "icon": "fa-certificate",
                "title": f"IPOPHL progress: {avg_score}% readiness",
                "meta": (
                    latest_doc.upload_timestamp.isoformat()
                    if latest_doc.upload_timestamp
                    else now.isoformat()
                ),
                "detail": (
                    f"{ready_docs}/{total_docs} analyzed document(s) are marked ready. "
                    "Open IPOPHL to continue the current GI registration flow."
                ),
                "category": "ipophl-progress",
                "category_label": "IPOPHL",
                "read": False,
            }
        )
    else:
        notifications.append(
            {
                "id": "ipophl-progress-empty",
                "icon": "fa-certificate",
                "title": "IPOPHL progress: no analyzed documents yet",
                "meta": now.isoformat(),
                "detail": "Upload and analyze IPOPHL files to start readiness tracking.",
                "category": "ipophl-progress",
                "category_label": "IPOPHL",
                "read": False,
            }
        )

    notifications.sort(key=lambda item: item.get("meta", ""), reverse=True)
    return jsonify({"items": notifications})


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
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    action = request.form.get("action")
    user_phone = session.get("user_phone")
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
            log_activity(user_phone, "2FA_ENABLED", "Two-factor authentication enabled", request.remote_addr)
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
            log_activity(user_phone, "2FA_DISABLED", "Two-factor authentication disabled", request.remote_addr)
            return jsonify({"success": "2FA disabled successfully"})
    
    return jsonify({"error": "Invalid action"})


@app.route("/settings/notifications", methods=["POST"])
def settings_notifications():
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    settings = load_settings()
    
    notifications = {
        "email_system_events": request.form.get("email_system_events") == "true",
        "email_user_registrations": request.form.get("email_user_registrations") == "true",
        "email_security_breaches": request.form.get("email_security_breaches") == "true",
        "sms_system_events": request.form.get("sms_system_events") == "true",
        "sms_user_registrations": request.form.get("sms_user_registrations") == "true",
        "sms_security_breaches": request.form.get("sms_security_breaches") == "true",
        "in_app_system_events": request.form.get("in_app_system_events") == "true",
        "in_app_user_registrations": request.form.get("in_app_user_registrations") == "true",
        "in_app_security_breaches": request.form.get("in_app_security_breaches") == "true",
    }
    
    settings["notifications"] = notifications
    save_settings(settings)
    
    user_phone = session.get("user_phone")
    log_activity(user_phone, "NOTIFICATIONS_UPDATED", "Notification preferences updated", request.remote_addr)
    
    return jsonify({"success": "Notification settings updated"})


@app.route("/settings/profile", methods=["POST"])
def settings_profile():
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    user_phone = session.get("user_phone")
    full_name = request.form.get("full_name", "").strip()
    
    if not full_name:
        return jsonify({"error": "Full name is required"})
    
    users = load_users()
    users[user_phone]["full_name"] = full_name
    save_users(users)
    
    session["user_name"] = full_name
    log_activity(user_phone, "PROFILE_UPDATED", f"Profile updated: {full_name}", request.remote_addr)
    
    return jsonify({"success": "Profile updated successfully"})


# Export Routes
@app.route("/export/excel")
def export_excel():
    if not session.get("user_phone"):
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
    if not session.get("user_phone"):
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
    if not session.get("user_phone"):
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


# File Preview Route for IPOPHL Module
@app.route("/api/ipo-preview/<file_uuid>")
def api_ipo_file_preview(file_uuid):
    """Preview a specific uploaded file in the IPOPHL module"""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    try:
        # Find document record
        doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
        if not doc_analysis:
            return jsonify({"error": "File not found"}), 404
        
        # Check if file exists
        file_path = Path(doc_analysis.file_path)
        if not file_path.exists():
            return jsonify({"error": "File not found on disk"}), 404
        
        # Return file info and preview URL
        return jsonify({
            "success": True,
            "file_info": {
                "filename": doc_analysis.original_filename,
                "file_type": doc_analysis.file_type,
                "file_size": doc_analysis.file_size,
                "upload_timestamp": doc_analysis.upload_timestamp.isoformat(),
                "ipophl_phase": doc_analysis.ipophl_phase,
                "task_id": doc_analysis.task_id
            },
            "preview_url": f"/api/file-preview/{file_uuid}{doc_analysis.file_type}",
            "analysis": {
                "ai_score": doc_analysis.ai_score,
                "ai_status": doc_analysis.ai_status,
                "detected_features": doc_analysis.detected_features_list,
                "missing_requirements": doc_analysis.missing_requirements_list
            }
        })
        
    except Exception as e:
        return jsonify({"error": f"Preview failed: {str(e)}"}), 500

# IPOPHL AI Analysis Routes
@app.route("/api/ipo-analyze", methods=["POST"])
def api_ipo_analyze():
    """Handle file upload and AI analysis for IPOPHL documents"""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    try:
        # Import AI engine
        from machinelearning.ai_engine import gi_analyzer
        
        # Check if file was uploaded
        if 'file' not in request.files:
            return jsonify({"error": "No file provided"}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({"error": "No file selected"}), 400
        
        # Get additional metadata
        ipophl_phase = request.form.get('phase', 'unknown')
        task_id = request.form.get('task_id', 'unknown')
        
        # Validate file type
        allowed_extensions = {'.pdf', '.doc', '.docx', '.txt', '.md'}
        file_ext = Path(file.filename).suffix.lower()
        if file_ext not in allowed_extensions:
            return jsonify({"error": f"Unsupported file type: {file_ext}"}), 400
        
        # Save file securely
        file_path = gi_analyzer.save_uploaded_file(file, file.filename)
        
        # Perform AI analysis
        analysis_result = gi_analyzer.analyze_document(file_path)
        
        if not analysis_result.get('success', False):
            return jsonify({"error": analysis_result.get('error', 'Analysis failed')}), 500
        
        # Save analysis to database
        file_uuid = Path(file_path).stem  # UUID without extension
        
        # Check if analysis already exists
        existing_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
        if existing_analysis:
            # Update existing record
            doc_analysis = existing_analysis
        else:
            # Create new record
            doc_analysis = DocumentAnalysis(
                file_uuid=file_uuid,
                original_filename=secure_filename(file.filename),
                file_path=file_path,
                file_type=file_ext,
                file_size=os.path.getsize(file_path),
                ipophl_phase=ipophl_phase,
                task_id=task_id
            )
        
        # Update analysis results
        doc_analysis.ai_score = analysis_result.get('readiness_score', 0)
        doc_analysis.ai_status = analysis_result.get('status', 'Not Ready')
        doc_analysis.set_detected_features(analysis_result.get('detected_features', []))
        doc_analysis.set_missing_requirements(analysis_result.get('missing_requirements', []))
        doc_analysis.analysis_method = analysis_result.get('analysis_method', 'rule_based')
        doc_analysis.text_length = analysis_result.get('text_length', 0)
        doc_analysis.analysis_timestamp = datetime.utcnow()
        
        # Save to database
        if existing_analysis:
            db.session.commit()
        else:
            db.session.add(doc_analysis)
            db.session.commit()
        
        # Log activity
        user_phone = session.get("user_phone")
        log_activity(user_phone, "IPOPHL_DOCUMENT_ANALYZED", 
                    f"Analyzed {file.filename} - Score: {doc_analysis.ai_score}%", 
                    request.remote_addr)
        
        # Return analysis results
        return jsonify({
            "success": True,
            "file_uuid": file_uuid,
            "filename": file.filename,
            "analysis": {
                "readiness_score": doc_analysis.ai_score,
                "status": doc_analysis.ai_status,
                "detected_features": doc_analysis.detected_features_list,
                "missing_requirements": doc_analysis.missing_requirements_list,
                "analysis_method": doc_analysis.analysis_method,
                "text_length": doc_analysis.text_length
            },
            "preview_url": gi_analyzer.get_file_preview_url(file_path),
            "ipophl_phase": ipophl_phase,
            "task_id": task_id
        })
        
    except Exception as e:
        # Log error
        user_phone = session.get("user_phone")
        log_activity(user_phone, "IPOPHL_ANALYSIS_ERROR", str(e), request.remote_addr)
        return jsonify({"error": f"Analysis failed: {str(e)}"}), 500

@app.route("/api/file-preview/<filename>")
def api_file_preview(filename):
    """Serve uploaded files for preview"""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    try:
        # Validate filename to prevent directory traversal
        filename = secure_filename(filename)
        if not filename:
            return jsonify({"error": "Invalid filename"}), 400
        
        # Construct file path
        file_path = Path("uploads") / filename
        
        # Check if file exists
        if not file_path.exists():
            return jsonify({"error": "File not found"}), 404
        
        # Determine MIME type
        if filename.endswith('.pdf'):
            mimetype = 'application/pdf'
        elif filename.endswith(('.doc', '.docx')):
            mimetype = 'application/msword'
        elif filename.endswith(('.txt', '.md')):
            mimetype = 'text/plain'
        else:
            mimetype = 'application/octet-stream'
        
        return send_file(str(file_path), mimetype=mimetype)
        
    except Exception as e:
        return jsonify({"error": f"Preview failed: {str(e)}"}), 500

@app.route("/api/ipo-analysis/<file_uuid>", methods=["GET"])
def api_get_analysis(file_uuid):
    """Get existing analysis results for a file"""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    try:
        # Find analysis record
        doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
        if not doc_analysis:
            return jsonify({"error": "Analysis not found"}), 404
        
        return jsonify({
            "success": True,
            "file_uuid": file_uuid,
            "filename": doc_analysis.original_filename,
            "analysis": {
                "readiness_score": doc_analysis.ai_score,
                "status": doc_analysis.ai_status,
                "detected_features": doc_analysis.detected_features_list,
                "missing_requirements": doc_analysis.missing_requirements_list,
                "analysis_method": doc_analysis.analysis_method,
                "text_length": doc_analysis.text_length
            },
            "preview_url": f"/api/file-preview/{file_uuid}{doc_analysis.file_type}",
            "ipophl_phase": doc_analysis.ipophl_phase,
            "task_id": doc_analysis.task_id,
            "upload_timestamp": doc_analysis.upload_timestamp.isoformat(),
            "analysis_timestamp": doc_analysis.analysis_timestamp.isoformat() if doc_analysis.analysis_timestamp else None
        })
        
    except Exception as e:
        return jsonify({"error": f"Failed to get analysis: {str(e)}"}), 500

@app.route("/api/ipo-analysis/<file_uuid>", methods=["POST"])
def api_refresh_analysis(file_uuid):
    """Re-run analysis on an existing file"""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    try:
        # Find analysis record
        doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
        if not doc_analysis:
            return jsonify({"error": "Analysis not found"}), 404
        
        # Import AI engine
        from machinelearning.ai_engine import gi_analyzer
        
        # Re-run analysis
        analysis_result = gi_analyzer.analyze_document(doc_analysis.file_path)
        
        if not analysis_result.get('success', False):
            return jsonify({"error": analysis_result.get('error', 'Analysis failed')}), 500
        
        # Update analysis results
        doc_analysis.ai_score = analysis_result.get('readiness_score', 0)
        doc_analysis.ai_status = analysis_result.get('status', 'Not Ready')
        doc_analysis.set_detected_features(analysis_result.get('detected_features', []))
        doc_analysis.set_missing_requirements(analysis_result.get('missing_requirements', []))
        doc_analysis.analysis_method = analysis_result.get('analysis_method', 'rule_based')
        doc_analysis.text_length = analysis_result.get('text_length', 0)
        doc_analysis.analysis_timestamp = datetime.utcnow()
        
        db.session.commit()
        
        # Log activity
        user_phone = session.get("user_phone")
        log_activity(user_phone, "IPOPHL_ANALYSIS_REFRESHED", 
                    f"Refreshed analysis for {doc_analysis.original_filename} - Score: {doc_analysis.ai_score}%", 
                    request.remote_addr)
        
        return jsonify({
            "success": True,
            "message": "Analysis refreshed successfully",
            "analysis": {
                "readiness_score": doc_analysis.ai_score,
                "status": doc_analysis.ai_status,
                "detected_features": doc_analysis.detected_features_list,
                "missing_requirements": doc_analysis.missing_requirements_list,
                "analysis_method": doc_analysis.analysis_method,
                "text_length": doc_analysis.text_length
            }
        })
        
    except Exception as e:
        return jsonify({"error": f"Refresh failed: {str(e)}"}), 500

@app.route("/api/ipo-documents", methods=["GET"])
def api_list_documents():
    """List all analyzed documents"""
    if not session.get("user_phone"):
        return jsonify({"error": "Unauthorized"}), 401
    
    try:
        # Get query parameters
        phase = request.args.get('phase')
        limit = int(request.args.get('limit', 50))
        
        # Build query
        query = DocumentAnalysis.query
        if phase:
            query = query.filter_by(ipophl_phase=phase)
        
        documents = query.order_by(DocumentAnalysis.upload_timestamp.desc()).limit(limit).all()
        
        results = []
        for doc in documents:
            results.append({
                "file_uuid": doc.file_uuid,
                "filename": doc.original_filename,
                "file_type": doc.file_type,
                "file_size": doc.file_size,
                "ai_score": doc.ai_score,
                "ai_status": doc.ai_status,
                "ipophl_phase": doc.ipophl_phase,
                "task_id": doc.task_id,
                "upload_timestamp": doc.upload_timestamp.isoformat(),
                "analysis_timestamp": doc.analysis_timestamp.isoformat() if doc.analysis_timestamp else None,
                "preview_url": f"/api/file-preview/{doc.file_uuid}{doc.file_type}"
            })
        
        return jsonify({
            "success": True,
            "documents": results,
            "total": len(results)
        })
        
    except Exception as e:
        return jsonify({"error": f"Failed to list documents: {str(e)}"}), 500

# Create database tables and populate with data
with app.app_context():
    # Migrate old email-based admin tables to phone_number schema
    try:
        inspector = db.inspect(db.engine)
        tables = inspector.get_table_names()
        if "admin_user" in tables:
            columns = [c["name"] for c in inspector.get_columns("admin_user")]
            if "email" in columns and "phone_number" not in columns:
                with db.engine.connect() as conn:
                    conn.execute(text("DROP TABLE IF EXISTS admin_user"))
                    conn.execute(text("DROP TABLE IF EXISTS activity_log_entry"))
                    conn.commit()
    except Exception:
        pass

    db.create_all()

    # Backup old email-based users.json since auth now uses phone numbers
    if USER_DB.exists():
        try:
            old_data = json.loads(USER_DB.read_text(encoding="utf-8"))
            if old_data and isinstance(old_data, dict):
                backup = USER_DB.with_suffix(".json.bak")
                if backup.exists():
                    backup.unlink()
                USER_DB.rename(backup)
        except Exception:
            pass

if __name__ == "__main__":
    app.run(debug=True, port=5001)
