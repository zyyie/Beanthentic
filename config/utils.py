"""
Utility functions for Beanthentic application.

Provides helper functions for user management, settings,
activity logging, and database operations.
"""

import json
from datetime import datetime
from pathlib import Path

from flask import session

from config.models import (
    ActivityLogEntry,
    AdminUser,
    db,
)

# Database paths
USER_DB = Path(__file__).resolve().parent.parent / "data" / "users.json"
SETTINGS_DB = Path(__file__).resolve().parent.parent / "settings.json"


def _load_users_json() -> dict:
    """Load admin accounts from users.json (legacy / backup)."""
    if not USER_DB.exists():
        return {}
    try:
        raw = json.loads(USER_DB.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except json.JSONDecodeError:
        return {}


def _normalize_users_dict(users: dict) -> dict:
    """Normalize phone keys to 10-digit PH mobile format where possible."""
    from config.validation import validate_phone

    out: dict = {}
    for key, data in (users or {}).items():
        if not isinstance(data, dict):
            continue
        ok, _, normalized = validate_phone(str(key))
        phone_key = normalized if ok else str(key).strip()
        if not phone_key:
            continue
        merged = dict(out.get(phone_key) or {})
        for field, value in data.items():
            if value is None:
                continue
            if field == "password_hash":
                if value and (not merged.get("password_hash") or len(str(value)) >= len(str(merged.get("password_hash", "")))):
                    merged["password_hash"] = value
            elif not merged.get(field):
                merged[field] = value
        out[phone_key] = merged
    return out


def _users_from_db() -> dict | None:
    """Load admin accounts from admin_user table. Returns None if DB unavailable."""
    try:
        rows = AdminUser.query.all()
    except Exception:
        return None
    users: dict = {}
    for row in rows:
        phone = str(row.phone_number or "").strip()
        if not phone or not row.password_hash:
            continue
        users[phone] = {
            "full_name": str(row.full_name or "").strip(),
            "password_hash": str(row.password_hash or "").strip(),
        }
    return users


def load_users() -> dict:
    """Load admin accounts — database is source of truth when available."""
    json_users = _normalize_users_dict(_load_users_json())
    db_users = _users_from_db()
    if db_users is None:
        return json_users
    if not db_users and json_users:
        try:
            _sync_users_to_db(json_users)
            db_users = _users_from_db() or json_users
        except Exception:
            db_users = json_users
    merged = dict(json_users)
    merged.update(db_users)
    for phone, db_data in db_users.items():
        if phone not in merged:
            merged[phone] = dict(db_data)
            continue
        for field, value in db_data.items():
            if field == "password_hash" and value:
                merged[phone]["password_hash"] = value
            elif value and not merged[phone].get(field):
                merged[phone][field] = value
    return _normalize_users_dict(merged)


def save_users(users: dict) -> None:
    """Persist admin accounts to database and users.json backup."""
    users = _normalize_users_dict(users)
    USER_DB.parent.mkdir(parents=True, exist_ok=True)
    USER_DB.write_text(json.dumps(users, indent=2), encoding="utf-8")
    try:
        _sync_users_to_db(users)
    except Exception:
        pass


def _sync_users_to_db(users: dict | None = None) -> None:
    """Upsert admin accounts into admin_user."""
    users = _normalize_users_dict(users if users is not None else _load_users_json())
    for phone, data in users.items():
        phone = str(phone).strip()
        full_name = str(data.get("full_name") or "").strip() or "Admin"
        password_hash = str(data.get("password_hash") or "").strip()
        if not phone or not password_hash:
            continue
        existing = AdminUser.query.filter_by(phone_number=phone).first()
        if existing:
            existing.full_name = full_name
            existing.password_hash = password_hash
        else:
            db.session.add(
                AdminUser(
                    phone_number=phone,
                    full_name=full_name,
                    password_hash=password_hash,
                )
            )
    db.session.commit()


def sync_users_json_to_db() -> None:
    """Backward-compatible alias — sync users.json into admin_user."""
    _sync_users_to_db(_load_users_json())


def ensure_admin_users_migrated() -> None:
    """Create admin_user table if needed and migrate JSON accounts into the database."""
    from sqlalchemy import inspect, text

    try:
        inspector = inspect(db.engine)
        if "admin_user" not in inspector.get_table_names():
            db.session.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS admin_user (
                        id SERIAL PRIMARY KEY,
                        phone_number VARCHAR(255) UNIQUE NOT NULL,
                        full_name VARCHAR(255) NOT NULL,
                        password_hash VARCHAR(512) NOT NULL,
                        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
            )
            db.session.commit()
    except Exception:
        db.session.rollback()
        try:
            db.create_all()
        except Exception:
            db.session.rollback()

    json_users = _normalize_users_dict(_load_users_json())
    if json_users:
        try:
            _sync_users_to_db(json_users)
        except Exception:
            db.session.rollback()

    db_users = _users_from_db()
    if db_users:
        merged = _normalize_users_dict({**json_users, **db_users})
        try:
            USER_DB.parent.mkdir(parents=True, exist_ok=True)
            USER_DB.write_text(json.dumps(merged, indent=2), encoding="utf-8")
        except OSError:
            pass


def resolve_user_phone_key(users: dict, phone_digits: str) -> str | None:
    """
    Find the users.json key for a normalized 10-digit PH mobile number.
    Handles legacy keys like 09XXXXXXXXX.
    """
    from config.validation import validate_phone

    target = (phone_digits or "").strip()
    if not target:
        return None
    if target in users:
        return target
    for key in users:
        ok, _, normalized = validate_phone(str(key))
        if ok and normalized == target:
            return str(key)
    return None


def has_admin_account() -> bool:
    """Check if at least one admin user exists."""
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
    """Load settings from JSON file."""
    default_settings = {
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
        "sms": {
            "enabled": True,
            "provider": "sms_gateway",
            "sender_name": "Beanthentic",
            "public_base_url": "http://127.0.0.1:5000",
            "sms_gateway": {
                "mode": "local",
                "local_base_url": "",
                "local_path": "/message",
                "cloud_url": "https://api.sms-gate.app/3rdparty/v1/messages",
                "username": "",
                "password": "",
                "sim_number": 1,
            },
        },
    }

    if not SETTINGS_DB.exists():
        return default_settings
    try:
        return json.loads(SETTINGS_DB.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default_settings


def save_settings(settings: dict) -> None:
    """Save settings to JSON file."""
    SETTINGS_DB.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def log_activity(user_phone: str, action: str, details: str = "", ip_address: str = "") -> None:
    """Log activity to database."""
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


def get_current_user_phone() -> str | None:
    """Get current logged-in user's phone number."""
    return session.get("user_phone")


def get_current_admin_account() -> dict:
    """
    Resolve the logged-in admin against users.json and session.
    Tolerates legacy phone key formats; profile photos use normalized storage_phone.
    """
    from config.validation import validate_phone

    session_phone = (get_current_user_phone() or "").strip()
    users = load_users()
    phone_key = resolve_user_phone_key(users, session_phone) if session_phone else None
    if not phone_key:
        phone_key = session_phone

    user = {}
    if phone_key and phone_key in users:
        user = users[phone_key]
    elif session_phone and session_phone in users:
        phone_key = session_phone
        user = users[session_phone]

    ok, _, normalized = validate_phone(session_phone or phone_key or "")
    storage_phone = normalized if ok else (session_phone or phone_key or "").strip()
    if not storage_phone:
        import re

        digits = re.sub(r"\D+", "", session_phone or phone_key or "")
        if digits.startswith("63") and len(digits) >= 12:
            digits = digits[2:]
        if digits.startswith("0") and len(digits) == 11:
            digits = digits[1:]
        if len(digits) == 10 and digits.startswith("9"):
            storage_phone = digits
    display_phone = storage_phone or session_phone or phone_key or ""

    full_name = (user.get("full_name") or session.get("user_name") or "").strip()
    first_name = (user.get("first_name") or "").strip()
    last_name = (user.get("last_name") or "").strip()
    if not first_name and full_name:
        parts = full_name.split(None, 1)
        first_name = parts[0] if parts else ""
        last_name = parts[1] if len(parts) > 1 else ""

    return {
        "phone_key": phone_key or "",
        "storage_phone": storage_phone,
        "display_phone": display_phone,
        "user": user,
        "full_name": full_name,
        "first_name": first_name,
        "last_name": last_name,
        "has_users_record": bool(user),
    }


def get_current_farmer_phone() -> str | None:
    """Get current logged-in farmer's phone number."""
    return session.get("farmer_phone")


def is_farmer_authenticated() -> bool:
    """Check if farmer is authenticated."""
    return session.get("farmer_phone") is not None


def is_authenticated() -> bool:
    """Check if user is authenticated."""
    return session.get("user_phone") is not None
