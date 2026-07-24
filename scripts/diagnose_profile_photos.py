#!/usr/bin/env python3
"""Check why farmer profile photos may not appear after a Supabase wipe."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: E402

beanthentic_env.load_dotenv(ROOT / ".env")


def main() -> int:
    print("=== Beanthentic profile photo diagnostics ===\n")

    url = beanthentic_env.supabase_url()
    anon = bool(beanthentic_env.supabase_anon_key())
    service = bool(beanthentic_env.supabase_service_role_key())
    bucket = beanthentic_env.supabase_storage_bucket()

    print(f"Supabase URL:        {'set' if url else 'MISSING'}")
    print(f"Anon key:            {'set' if anon else 'MISSING'}")
    print(f"Service role key:    {'set' if service else 'MISSING — uploads/backfill will fail'}")
    print(f"Storage bucket:      {bucket}")
    print(f"PostgreSQL mode:     {beanthentic_env.is_postgresql()}")

    if not beanthentic_env.is_postgresql():
        print("\nAdmin is not using PostgreSQL/Supabase for farmer data.")
        print("Set BEANTHENTIC_DB_TYPE=postgresql and DB credentials in .env")
        return 1

    try:
        conn = beanthentic_env.connect()
    except Exception as exc:
        print(f"\nDatabase connection failed: {exc}")
        return 1

    from config.farmer_profile_photo import fetch_farmer_photo_record, photo_record_to_bytes

    try:
        with conn.cursor() as cur:
            cur.execute("SELECT farmer_id, profile_photo FROM farmers ORDER BY farmer_id")
            rows = cur.fetchall()
    finally:
        conn.close()

    total = len(rows)
    print(f"\nFarmers in database: {total}")

    if total == 0:
        print("\nNo farmers yet. Register a test farmer on the mobile app, then re-run this script.")
        return 0

    empty = supabase_url = bare_path = data_url = other = 0
    can_serve = 0
    storage_ok = 0

    conn = beanthentic_env.connect()
    try:
        for row in rows:
            if isinstance(row, dict):
                fid = int(row.get("farmer_id") or 0)
                stored = str(row.get("profile_photo") or "").strip()
            else:
                fid = int(row[0])
                stored = str(row[1] or "").strip()

            if not stored:
                empty += 1
            elif stored.startswith("data:image/"):
                data_url += 1
            elif "supabase.co/storage/" in stored:
                supabase_url += 1
            elif stored.startswith("/uploads") or stored.startswith("uploads/"):
                bare_path += 1
            else:
                other += 1

            rec = fetch_farmer_photo_record(conn, fid)
            blob = photo_record_to_bytes(rec, fid)
            if blob:
                can_serve += 1

            if stored and "supabase.co/storage/" in stored:
                name = Path(stored.split("/")[-1]).name
                if beanthentic_env.download_from_supabase_storage(name):
                    storage_ok += 1

            mark = "readable" if blob else "NOT FOUND"
            preview = (stored[:60] + "…") if len(stored) > 60 else (stored or "(empty)")
            print(f"  farmer {fid}: {mark} — {preview}")
    finally:
        conn.close()

    print("\n--- Summary ---")
    print(f"  profile_photo empty:     {empty}")
    print(f"  Supabase storage URL:    {supabase_url} ({storage_ok} downloadable)")
    print(f"  data: URL in column:     {data_url}")
    print(f"  bare path only:          {bare_path}")
    print(f"  other:                   {other}")
    print(f"  admin can load bytes:    {can_serve}/{total}")

    print("\n--- What to do ---")
    if not service:
        print("1. Add BEANTHENTIC_SUPABASE_SERVICE_ROLE_KEY to .env (Supabase → Settings → API).")
    print("2. Run: python scripts/setup_supabase_profile_photos.py")
    print("   (creates profile-photos bucket + uploads any photos still in the DB).")
    if empty or bare_path:
        print("3. Re-register farmers on the mobile app WITH a profile photo,")
        print("   OR ensure Beanthentic-App saves a Supabase Storage URL on registration.")
    print("4. Restart web.py and hard-refresh the dashboard (Ctrl+F5).")
    print("5. Test: open /api/farmer-profile-photo/1 in the browser while logged in.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
