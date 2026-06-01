"""Admin profile photo storage on disk."""

from __future__ import annotations

import time
from pathlib import Path

from config.validation import ALLOWED_PROFILE_PHOTO_EXTENSIONS, validate_phone

PROFILE_PHOTOS_DIR = Path(__file__).resolve().parents[1] / "data" / "profile_photos"


def normalize_profile_phone_key(phone: str) -> str:
    """Use a stable 10-digit key for profile photo filenames."""
    raw = str(phone or "").strip()
    if not raw:
        return ""
    ok, _, normalized = validate_phone(raw)
    return normalized if ok else raw


def ensure_profile_photos_dir() -> None:
    PROFILE_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)


def profile_photo_file(phone: str) -> Path | None:
    """Return existing profile photo path for phone, if any."""
    key = normalize_profile_phone_key(phone)
    if not key:
        return None
    for ext in ALLOWED_PROFILE_PHOTO_EXTENSIONS:
        candidate = PROFILE_PHOTOS_DIR / f"{key}{ext}"
        if candidate.is_file():
            return candidate
    return None


def profile_photo_url(phone: str) -> str | None:
    if profile_photo_file(phone):
        return f"/settings/profile-photo?v={int(time.time())}"
    return None


def migrate_profile_photo_key(old_phone: str, new_phone: str) -> None:
    """Rename stored profile photo when admin phone key changes."""
    old_key = normalize_profile_phone_key(old_phone)
    new_key = normalize_profile_phone_key(new_phone)
    if not old_key or not new_key or old_key == new_key:
        return
    path = profile_photo_file(old_key)
    if not path:
        return
    dest = PROFILE_PHOTOS_DIR / f"{new_key}{path.suffix.lower()}"
    ensure_profile_photos_dir()
    for old_ext in ALLOWED_PROFILE_PHOTO_EXTENSIONS:
        candidate = PROFILE_PHOTOS_DIR / f"{new_key}{old_ext}"
        if candidate.is_file():
            candidate.unlink()
    path.rename(dest)


def save_profile_photo(phone: str, file_storage, *, ext: str) -> Path:
    """Save uploaded bytes for phone; removes other extensions first."""
    ensure_profile_photos_dir()
    key = normalize_profile_phone_key(phone)
    if not key:
        raise ValueError("Invalid user.")

    normalized_ext = ext if ext.startswith(".") else f".{ext}"
    if normalized_ext.lower() not in ALLOWED_PROFILE_PHOTO_EXTENSIONS:
        raise ValueError("Unsupported image type.")

    for old_ext in ALLOWED_PROFILE_PHOTO_EXTENSIONS:
        old = PROFILE_PHOTOS_DIR / f"{key}{old_ext}"
        if old.is_file():
            old.unlink()

    dest = PROFILE_PHOTOS_DIR / f"{key}{normalized_ext.lower()}"
    file_storage.save(dest)
    return dest
