"""
Shared input validation for Beanthentic (admin web, APIs, forms).
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from html import escape
from urllib.parse import urlparse

# Philippine mobile: 10 digits starting with 9 (no country code in forms).
_PHONE_RE = re.compile(r"^9\d{9}$")
_DISALLOWED_TEXT = re.compile(r"[<>]")

PASSWORD_MIN_LEN = 8
PASSWORD_MAX_LEN = 128

MESSAGE_SUBJECT_MAX = 300
MESSAGE_BODY_MAX = 10000
REASON_MAX = 500
NAME_MAX = 120
NOTIFICATION_MESSAGE_MAX = 2000
UPDATE_TITLE_MAX = 200
UPDATE_CONTENT_MAX = 10000
URL_MAX = 2048

COFFEE_VARIETIES = frozenset({"liberica", "excelsa", "robusta"})
FARMER_ACCOUNT_ACTIONS = frozenset({"warning", "suspend", "unsuspend"})
MESSAGE_CATEGORIES = frozenset({"general", "farmer-update", "farmers", "announcement", "reminder"})
PAYMENT_METHODS = frozenset({"cash", "bank", "gcash", "maya", "check", "other", ""})
IPOPHL_PHASES = frozenset({"unknown", "phase1", "phase2", "phase3", "registration", "application"})
ALLOWED_UPLOAD_EXTENSIONS = frozenset({".pdf", ".doc", ".docx", ".txt", ".md", ".csv"})
ALLOWED_PROFILE_PHOTO_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif"})
PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024
MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB


def validate_phone(phone: str) -> tuple[bool, str, str]:
    """Validate PH mobile (10 digits, starts with 9). Returns (ok, error, normalized)."""
    raw = (phone or "").strip()
    if not raw:
        return False, "Phone number is required.", ""
    digits = re.sub(r"\D+", "", raw)
    if digits.startswith("63") and len(digits) >= 12:
        digits = digits[2:]
    if digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    if not _PHONE_RE.match(digits):
        return False, "Phone number must be exactly 10 digits starting with 9 (e.g., 9123456789).", ""
    return True, "", digits


def validate_password(password: str, confirm: str | None = None) -> tuple[bool, str]:
    pwd = password or ""
    if len(pwd) < PASSWORD_MIN_LEN:
        return False, f"Password must be at least {PASSWORD_MIN_LEN} characters."
    if len(pwd) > PASSWORD_MAX_LEN:
        return False, f"Password must be at most {PASSWORD_MAX_LEN} characters."
    if not re.search(r"[A-Za-z]", pwd) or not re.search(r"\d", pwd):
        return False, "Password must include at least one letter and one number."
    if confirm is not None and pwd != confirm:
        return False, "Passwords do not match."
    return True, ""


def validate_full_name(name: str) -> tuple[bool, str, str]:
    cleaned = clean_text(name, NAME_MAX, "Full name", allow_empty=False)
    if cleaned is None:
        return False, "Full name is required.", ""
    if len(cleaned) < 2:
        return False, "Full name must be at least 2 characters.", ""
    return True, "", cleaned


def clean_text(
    value: str | None,
    max_len: int,
    field_label: str = "Value",
    *,
    allow_empty: bool = True,
) -> str | None:
    """
    Strip, reject angle brackets (basic XSS), enforce max length.
    Returns cleaned string, or None if empty and allow_empty is False.
    """
    s = (value or "").strip()
    if not s:
        return "" if allow_empty else None
    if _DISALLOWED_TEXT.search(s):
        raise ValueError(f"{field_label} must not contain < or > characters.")
    if len(s) > max_len:
        raise ValueError(f"{field_label} must be at most {max_len} characters.")
    return s


def escape_display(text: str) -> str:
    return escape(text or "", quote=True)


def validate_enum(value: str | None, allowed: frozenset[str], default: str) -> str:
    s = (value or "").strip().lower()
    return s if s in allowed else default


def validate_positive_int(
    value,
    *,
    field: str = "value",
    minimum: int = 1,
    maximum: int = 2_147_483_647,
) -> tuple[bool, str, int]:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return False, f"{field} must be a whole number.", 0
    if n < minimum or n > maximum:
        return False, f"{field} must be between {minimum} and {maximum}.", 0
    return True, "", n


def validate_decimal_range(
    value,
    *,
    field: str = "value",
    allow_zero: bool = False,
    minimum: Decimal | None = None,
    maximum: Decimal | None = None,
) -> tuple[bool, str, Decimal | None]:
    if value is None or value == "":
        return True, "", None
    try:
        d = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return False, f"{field} must be a valid number.", None
    if not allow_zero and d == 0:
        return False, f"{field} cannot be zero.", None
    if minimum is not None and d < minimum:
        return False, f"{field} is below the allowed minimum.", None
    if maximum is not None and d > maximum:
        return False, f"{field} exceeds the allowed maximum.", None
    return True, "", d


def validate_url(url: str, *, required: bool = True) -> tuple[bool, str, str]:
    raw = (url or "").strip()
    if not raw:
        if required:
            return False, "URL is required.", ""
        return True, "", ""
    if len(raw) > URL_MAX:
        return False, f"URL must be at most {URL_MAX} characters.", ""
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False, "URL must start with http:// or https:// and include a valid host.", ""
    return True, "", raw


def validate_db_host(host: str) -> tuple[bool, str]:
    h = (host or "").strip()
    if not h:
        return False, "Database host is required."
    if len(h) > 253:
        return False, "Database host is too long."
    if _DISALLOWED_TEXT.search(h):
        return False, "Database host contains invalid characters."
    # IPv4, hostname, or localhost
    if re.match(r"^[\w.\-]+$", h) or re.match(r"^\d{1,3}(\.\d{1,3}){3}$", h):
        return True, ""
    return False, "Database host must be a valid hostname or IP address."


def validate_db_port(port_raw: str | int) -> tuple[bool, str, int]:
    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        return False, "Database port must be a number.", 3306
    if port < 1 or port > 65535:
        return False, "Database port must be between 1 and 65535.", 3306
    return True, "", port


def validate_db_name(name: str) -> tuple[bool, str, str]:
    n = (name or "").strip()
    if not n:
        return False, "Database name is required.", ""
    if not re.match(r"^[A-Za-z0-9_]+$", n):
        return False, "Database name may only contain letters, numbers, and underscores.", ""
    if len(n) > 64:
        return False, "Database name is too long.", ""
    return True, "", n


def validate_profile_photo_upload(filename: str, size_bytes: int) -> tuple[bool, str, str]:
    """Validate admin profile photo upload. Returns (ok, error, extension)."""
    from pathlib import Path

    ok_ext, err, ext = validate_filename_extension(
        filename,
        allowed=ALLOWED_PROFILE_PHOTO_EXTENSIONS,
        label="Profile photo",
    )
    if not ok_ext:
        return False, err, ""
    if size_bytes <= 0:
        return False, "Photo file is empty.", ""
    if size_bytes > PROFILE_PHOTO_MAX_BYTES:
        return False, "Photo must be 5 MB or smaller.", ""
    return True, "", ext


def validate_filename_extension(
    filename: str,
    *,
    allowed: frozenset[str] | None = None,
    label: str = "File",
) -> tuple[bool, str, str]:
    from pathlib import Path

    name = (filename or "").strip()
    if not name or name in (".", ".."):
        return False, "Invalid file name.", ""
    ext = Path(name).suffix.lower()
    allowed_set = allowed if allowed is not None else ALLOWED_UPLOAD_EXTENSIONS
    if ext not in allowed_set:
        exts = ", ".join(sorted(allowed_set))
        return False, f"Unsupported {label.lower()} type. Allowed: {exts}", ""
    return True, "", ext


def validate_uuid_like(value: str) -> tuple[bool, str]:
    s = (value or "").strip()
    if not s or len(s) > 64:
        return False, "Invalid identifier."
    if not re.match(r"^[A-Za-z0-9\-]+$", s):
        return False, "Invalid identifier format."
    return True, ""
