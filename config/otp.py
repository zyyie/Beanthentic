"""
One-time codes for SMS verification (password reset, etc.).
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta
from pathlib import Path

OTP_PURPOSE_ADMIN = "admin_password_reset"
OTP_PURPOSE_FARMER = "farmer_password_reset"

OTP_DB = Path(__file__).resolve().parent.parent / "data" / "otp_codes.json"
OTP_TTL_MINUTES = 10
OTP_LENGTH = 6
MAX_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60


def _hash_code(code: str) -> str:
    return hashlib.sha256(str(code).strip().encode("utf-8")).hexdigest()


def _load() -> dict:
    if not OTP_DB.exists():
        return {}
    try:
        raw = json.loads(OTP_DB.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except json.JSONDecodeError:
        return {}


def _save(data: dict) -> None:
    OTP_DB.parent.mkdir(parents=True, exist_ok=True)
    OTP_DB.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _purge(data: dict) -> dict:
    now = datetime.utcnow()
    kept: dict = {}
    for key, entry in data.items():
        if not isinstance(entry, dict):
            continue
        try:
            expires = datetime.fromisoformat(str(entry.get("expires_at")))
        except (TypeError, ValueError):
            continue
        if expires > now:
            kept[key] = entry
    return kept


def _entry_key(purpose: str, phone: str) -> str:
    return f"{purpose}:{phone}"


def generate_otp_code() -> str:
    return f"{secrets.randbelow(10 ** OTP_LENGTH):0{OTP_LENGTH}d}"


def can_resend(purpose: str, phone: str) -> tuple[bool, int]:
    """Return (allowed, seconds_remaining)."""
    data = _purge(_load())
    entry = data.get(_entry_key(purpose, phone))
    if not isinstance(entry, dict):
        return True, 0
    sent_raw = entry.get("sent_at")
    try:
        sent = datetime.fromisoformat(str(sent_raw))
    except (TypeError, ValueError):
        return True, 0
    elapsed = (datetime.utcnow() - sent).total_seconds()
    if elapsed >= RESEND_COOLDOWN_SECONDS:
        return True, 0
    return False, int(RESEND_COOLDOWN_SECONDS - elapsed)


def create_otp(purpose: str, phone: str, *, subject_id: str | int | None = None) -> tuple[str, str | None]:
    """Create a new OTP for phone. Returns (plain_code, error_message)."""
    allowed, wait = can_resend(purpose, phone)
    if not allowed:
        return "", f"Please wait {wait} seconds before requesting another code."

    code = generate_otp_code()
    data = _purge(_load())
    now = datetime.utcnow()
    data[_entry_key(purpose, phone)] = {
        "phone": phone,
        "subject_id": str(subject_id) if subject_id is not None else "",
        "code_hash": _hash_code(code),
        "attempts": 0,
        "sent_at": now.isoformat(timespec="seconds"),
        "expires_at": (now + timedelta(minutes=OTP_TTL_MINUTES)).isoformat(timespec="seconds"),
    }
    _save(data)
    return code, None


def verify_otp(purpose: str, phone: str, code: str) -> tuple[bool, str | None]:
    """Check OTP without consuming. Returns (ok, error_message)."""
    data = _purge(_load())
    key = _entry_key(purpose, phone)
    entry = data.get(key)
    if not isinstance(entry, dict):
        return False, "Code expired or not found. Request a new one."

    attempts = int(entry.get("attempts") or 0)
    if attempts >= MAX_ATTEMPTS:
        return False, "Too many failed attempts. Request a new code."

    if _hash_code(code) != str(entry.get("code_hash") or ""):
        entry["attempts"] = attempts + 1
        data[key] = entry
        _save(data)
        left = MAX_ATTEMPTS - int(entry["attempts"])
        return False, f"Invalid code. {left} attempt(s) left."

    return True, None


def consume_otp(purpose: str, phone: str, code: str) -> tuple[bool, str | None, str | None]:
    """Verify and delete OTP. Returns (ok, error, subject_id)."""
    ok, err = verify_otp(purpose, phone, code)
    if not ok:
        return False, err, None
    data = _load()
    key = _entry_key(purpose, phone)
    entry = data.pop(key, None)
    _save(_purge(data))
    subject_id = None
    if isinstance(entry, dict):
        sid = str(entry.get("subject_id") or "").strip()
        subject_id = sid or None
    return True, None, subject_id
