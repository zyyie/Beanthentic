"""Deep scan Supabase for farmer 19-25 photo data."""
from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config.supabase_client import get_client  # noqa: E402


def looks_like_image(val) -> bool:
    if val is None:
        return False
    if isinstance(val, (bytes, bytearray)) and len(val) > 64:
        return True
    s = str(val).strip()
    if s.startswith("data:image/"):
        return True
    if re.match(r"^https?://", s, re.I) and any(x in s.lower() for x in (".jpg", ".jpeg", ".png", ".webp", "storage")):
        return True
    if s.startswith("/uploads/") or "profile" in s.lower() or "photo" in s.lower():
        return len(s) > 8
    if len(s) > 200 and (s.startswith("/9j/") or s.startswith("iVBOR")):
        return True
    return False


def scan_row(label: str, row: dict) -> None:
    hits = []
    for k, v in row.items():
        if looks_like_image(v):
            preview = str(v)[:120].replace("\n", " ")
            hits.append((k, preview, len(str(v))))
    if hits:
        print(f"  {label}:")
        for k, preview, ln in hits:
            print(f"    {k} ({ln} chars): {preview}")


def main() -> None:
    c = get_client()
    for fid in range(19, 26):
        print(f"\n=== farmer_id {fid} ===")
        farmers = c.table("farmers").select("*").eq("farmer_id", fid).execute().data or []
        if farmers:
            scan_row("farmers", farmers[0])
            uid = farmers[0].get("user_id")
        else:
            uid = None
            print("  (no farmers row)")

        pi = c.table("personal_information").select("*").eq("farmer_id", fid).execute().data or []
        if pi:
            scan_row("personal_information", pi[0])

        if uid:
            users = c.table("users").select("*").eq("user_id", uid).execute().data or []
            if users:
                scan_row("users", users[0])

        # gi attachments might have selfie? unlikely
        gi = (
            c.table("gi_farmers_contribution")
            .select("attachments_json,content")
            .eq("farmer_id", fid)
            .limit(3)
            .execute()
            .data
            or []
        )
        if gi:
            print(f"  gi rows: {len(gi)}")


if __name__ == "__main__":
    main()
