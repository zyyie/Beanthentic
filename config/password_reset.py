"""
Secure password-reset tokens (file-backed, short-lived).
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta
from pathlib import Path

RESET_DB = Path(__file__).resolve().parent.parent / "data" / "password_reset_tokens.json"
TOKEN_TTL_MINUTES = 30


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _load_tokens() -> dict:
    if not RESET_DB.exists():
        return {}
    try:
        raw = json.loads(RESET_DB.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except json.JSONDecodeError:
        return {}


def _save_tokens(data: dict) -> None:
    RESET_DB.parent.mkdir(parents=True, exist_ok=True)
    RESET_DB.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _purge_expired(data: dict) -> dict:
    now = datetime.utcnow()
    kept: dict = {}
    for key, entry in data.items():
        if not isinstance(entry, dict):
            continue
        expires_raw = entry.get("expires_at")
        try:
            expires = datetime.fromisoformat(str(expires_raw))
        except (TypeError, ValueError):
            continue
        if expires > now:
            kept[key] = entry
    return kept


def create_password_reset(phone: str) -> str:
    """Create a reset token for the given phone. Returns the plain URL token."""
    data = _purge_expired(_load_tokens())
    plain = secrets.token_urlsafe(32)
    expires = datetime.utcnow() + timedelta(minutes=TOKEN_TTL_MINUTES)
    data[_hash_token(plain)] = {
        "phone": phone,
        "expires_at": expires.isoformat(timespec="seconds"),
        "created_at": datetime.utcnow().isoformat(timespec="seconds"),
    }
    _save_tokens(data)
    return plain


def verify_reset_token(plain_token: str) -> str | None:
    """Return the phone number for a valid token, or None if invalid/expired."""
    token = (plain_token or "").strip()
    if not token:
        return None
    data = _purge_expired(_load_tokens())
    entry = data.get(_hash_token(token))
    if not isinstance(entry, dict):
        return None
    try:
        expires = datetime.fromisoformat(str(entry.get("expires_at")))
    except (TypeError, ValueError):
        return None
    if datetime.utcnow() > expires:
        return None
    phone = str(entry.get("phone") or "").strip()
    return phone or None


def consume_reset_token(plain_token: str) -> str | None:
    """Validate token, remove it, and return the associated phone."""
    phone = verify_reset_token(plain_token)
    if not phone:
        return None
    data = _load_tokens()
    data.pop(_hash_token(plain_token), None)
    _save_tokens(data)
    return phone
