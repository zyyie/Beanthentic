"""Repair broken farmers.profile_photo paths (upload to Supabase Storage)."""

from __future__ import annotations

import io
import re
from typing import Callable

import beanthentic_env
from config.farmer_profile_photo import (
    backfill_farmer_photo_to_storage,
    fetch_photo_bytes_from_app_server,
    profile_photo_storage_candidates,
)
from config.supabase_client import get_client


def is_broken_local_photo_ref(stored: str | None) -> bool:
    text = str(stored or "").strip()
    return bool(text) and text.startswith("/uploads/farmers/")


def farmer_display_name(client, farmer_id: int) -> str:
    pi = (
        client.table("personal_information")
        .select("first_name,last_name")
        .eq("farmer_id", farmer_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if pi:
        fn = str(pi[0].get("first_name") or "").strip()
        ln = str(pi[0].get("last_name") or "").strip()
        name = f"{fn} {ln}".strip()
        if name:
            return name
    rows = (
        client.table("farmers")
        .select("user_id")
        .eq("farmer_id", farmer_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if rows and rows[0].get("user_id"):
        uid = rows[0]["user_id"]
        users = (
            client.table("users")
            .select("username,email")
            .eq("user_id", uid)
            .limit(1)
            .execute()
            .data
            or []
        )
        if users:
            un = str(users[0].get("username") or users[0].get("email") or "").strip()
            if un:
                return un.split("@")[0]
    return f"Farmer {farmer_id}"


def initials_from_name(name: str) -> str:
    parts = [p for p in re.split(r"\s+", str(name or "").strip()) if p]
    if not parts:
        return "F"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def generate_initials_avatar(name: str, *, size: int = 512) -> tuple[bytes, str]:
    from PIL import Image, ImageDraw, ImageFont

    initials = initials_from_name(name)
    img = Image.new("RGB", (size, size), "#276749")
    draw = ImageDraw.Draw(img)
    for i in range(size):
        t = i / max(size - 1, 1)
        r = int(39 + (56 - 39) * t)
        g = int(122 + (161 - 122) * t)
        b = int(62 + (105 - 62) * t)
        draw.line([(0, i), (size, i)], fill=(r, g, b))
    font_size = int(size * 0.38)
    try:
        font = ImageFont.truetype("arial.ttf", font_size)
    except OSError:
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", font_size)
        except OSError:
            font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), initials, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(((size - tw) / 2, (size - th) / 2 - bbox[1]), initials, fill="#ffffff", font=font)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue(), "image/jpeg"


def photo_already_on_supabase(profile_photo: str | None, farmer_id: int) -> bool:
    text = str(profile_photo or "").strip()
    if text.startswith("https://") and "supabase.co/storage/" in text:
        for name in profile_photo_storage_candidates(text, farmer_id):
            if beanthentic_env.download_from_supabase_storage(name):
                return True
    for name in profile_photo_storage_candidates(text, farmer_id):
        if beanthentic_env.download_from_supabase_storage(name):
            return True
    return False


def fetch_existing_photo_bytes(profile_photo: str | None, farmer_id: int) -> tuple[bytes, str] | None:
    fid = int(farmer_id or 0)
    pp = str(profile_photo or "").strip()
    for name in profile_photo_storage_candidates(pp, fid):
        stored = beanthentic_env.download_from_supabase_storage(name)
        if stored:
            return stored
    if pp:
        app = fetch_photo_bytes_from_app_server(pp)
        if app:
            return app
    app = fetch_photo_bytes_from_app_server(f"/uploads/farmers/farmer_{fid}.jpg")
    return app


def repair_farmer_photo(
    farmer_id: int,
    *,
    allow_generated: bool = True,
    name_resolver: Callable[[int], str] | None = None,
) -> tuple[bool, str]:
    """
    Ensure farmer has a Supabase Storage profile photo URL.
    Returns (success, message).
    """
    fid = int(farmer_id or 0)
    if fid < 1:
        return False, "invalid farmer_id"

    client = get_client()
    rows = (
        client.table("farmers")
        .select("profile_photo")
        .eq("farmer_id", fid)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return False, "farmer not found"

    stored = str(rows[0].get("profile_photo") or "").strip()
    if photo_already_on_supabase(stored, fid) and not is_broken_local_photo_ref(stored):
        return True, "already on Supabase"

    body_mime = fetch_existing_photo_bytes(stored, fid)
    source = "existing"
    if not body_mime and allow_generated:
        name = (name_resolver(farmer_id) if name_resolver else farmer_display_name(client, fid))
        body_mime = generate_initials_avatar(name)
        source = "generated"

    if not body_mime:
        return False, "no photo source"

    body, mime = body_mime
    backfill_farmer_photo_to_storage(fid, body, mime)
    updated = (
        client.table("farmers")
        .select("profile_photo")
        .eq("farmer_id", fid)
        .limit(1)
        .execute()
        .data
        or []
    )
    new_url = str((updated[0] if updated else {}).get("profile_photo") or "")
    if new_url.startswith("https://") and "supabase.co/storage/" in new_url:
        return True, f"{source}: {new_url}"
    return False, "upload failed"


def repair_farmer_photo_range(
    start_id: int,
    end_id: int,
    *,
    allow_generated: bool = True,
) -> dict[int, tuple[bool, str]]:
    results: dict[int, tuple[bool, str]] = {}
    client = get_client()

    def resolver(fid: int) -> str:
        return farmer_display_name(client, fid)

    for fid in range(int(start_id), int(end_id) + 1):
        results[fid] = repair_farmer_photo(
            fid,
            allow_generated=allow_generated,
            name_resolver=resolver,
        )
    return results
