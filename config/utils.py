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


def load_users() -> dict:
    """Load users from JSON file."""
    if not USER_DB.exists():
        return {}
    try:
        return json.loads(USER_DB.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_users(users: dict) -> None:
    """Save users to JSON file."""
    USER_DB.write_text(json.dumps(users, indent=2), encoding="utf-8")
    # Keep sqlite in sync for Flask-Admin visibility.
    try:
        sync_users_json_to_db()
    except Exception:
        # Don't break app flow if DB sync fails.
        pass


def sync_users_json_to_db() -> None:
    """Sync users from JSON file to database."""
    users = load_users()
    for phone, data in users.items():
        phone = str(phone).strip()
        full_name = data.get("full_name", "").strip()
        password_hash = data.get("password_hash", "").strip()

        if not phone or not password_hash:
            continue

        existing = AdminUser.query.get(phone)
        if existing:
            existing.full_name = full_name
            existing.password_hash = password_hash
        else:
            db.session.add(
                AdminUser(
                    phone_number=phone,
                    full_name=full_name,
                    password_hash=password_hash
                )
            )
    db.session.commit()


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


def is_authenticated() -> bool:
    """Check if user is authenticated."""
    return session.get("user_phone") is not None
