"""Check and backfill profile photos for farmers 19-25."""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: E402
from config.app_connection import iter_legacy_asset_bases, optional_app_server_base  # noqa: E402
from config.farmer_profile_photo import (  # noqa: E402
    backfill_farmer_photo_to_storage,
    fetch_photo_bytes_from_app_server,
    profile_photo_storage_candidates,
)
from config.supabase_client import get_client  # noqa: E402


def try_http(url: str) -> tuple[bytes, str] | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Beanthentic-Admin/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = resp.read()
        if body and len(body) > 32:
            ctype = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
            if ctype.startswith("image/"):
                return body, ctype
    except Exception:
        return None
    return None


def fetch_photo_for_farmer(fid: int, profile_photo: str | None) -> tuple[bytes, str] | None:
    for name in profile_photo_storage_candidates(profile_photo, fid):
        stored = beanthentic_env.download_from_supabase_storage(name)
        if stored:
            return stored

    rel = str(profile_photo or f"/uploads/farmers/farmer_{fid}.jpg").strip()
    app = fetch_photo_bytes_from_app_server(rel)
    if app:
        return app

    for base in iter_legacy_asset_bases():
        for path in (f"/uploads/farmers/farmer_{fid}.jpg", rel):
            got = try_http(f"{base.rstrip('/')}{path if path.startswith('/') else '/' + path}")
            if got:
                return got

    admin_root = ROOT
    for folder in (
        admin_root / "uploads" / "farmers",
        admin_root.parent / "Beanthentic-App" / "uploads" / "farmers",
        admin_root / "deploy" / "app_server" / "uploads" / "farmers",
    ):
        for name in (f"farmer_{fid}.jpg", f"farmer_{fid}.jpeg", f"farmer_{fid}.png"):
            path = folder / name
            if path.is_file() and path.stat().st_size > 32:
                return path.read_bytes(), "image/jpeg"

    return None


def main() -> int:
    client = get_client()
    print("app_base:", optional_app_server_base())
    print("legacy_bases:", iter_legacy_asset_bases())
    print()

    ok = 0
    for fid in range(19, 26):
        rows = (
            client.table("farmers")
            .select("farmer_id,profile_photo")
            .eq("farmer_id", fid)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not rows:
            print(f"farmer {fid}: missing from DB")
            continue
        pp = rows[0].get("profile_photo")
        print(f"farmer {fid}: {str(pp)[:90] if pp else '(empty)'}")

        got = fetch_photo_for_farmer(fid, str(pp) if pp else None)
        if not got:
            print("  -> NO PHOTO FOUND")
            continue

        body, mime = got
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
        new_pp = str((updated[0] if updated else {}).get("profile_photo") or "")
        print(f"  -> OK ({len(body)} bytes) -> {new_pp[:90]}")
        ok += 1

    print(f"\nBackfilled {ok}/7 farmers.")
    return 0 if ok == 7 else 1


if __name__ == "__main__":
    raise SystemExit(main())
