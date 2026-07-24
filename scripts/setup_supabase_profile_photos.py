#!/usr/bin/env python3
"""
Create the profile-photos Supabase Storage bucket and backfill farmer registration photos.

Requires in Beanthentic-App/.env (or Beanthentic/.env):
  BEANTHENTIC_SUPABASE_SERVICE_ROLE_KEY  — Dashboard → Project Settings → API → service_role

Run from repo root:
  python scripts/setup_supabase_profile_photos.py
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = ROOT.parent / "Beanthentic-App"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(APP_ROOT))

import beanthentic_env  # noqa: E402

beanthentic_env.load_dotenv(ROOT / ".env")
beanthentic_env.load_dotenv(APP_ROOT / ".env")

BUCKET = os.getenv("BEANTHENTIC_SUPABASE_STORAGE_BUCKET", "profile-photos").strip() or "profile-photos"

BUCKET_SQL = f"""
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  '{BUCKET}',
  '{BUCKET}',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
"""

POLICY_SQL = f"""
DROP POLICY IF EXISTS "profile_photos_public_read" ON storage.objects;
CREATE POLICY "profile_photos_public_read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = '{BUCKET}');
"""

ALTER_SQL = """
ALTER TABLE farmers ALTER COLUMN profile_photo TYPE TEXT;
"""


def _pg_connect():
    import psycopg2

    ref = beanthentic_env.supabase_project_ref() if hasattr(beanthentic_env, "supabase_project_ref") else ""
    if not ref:
        ref = os.getenv("BEANTHENTIC_SUPABASE_PROJECT_REF", "").strip()
    user = os.getenv("BEANTHENTIC_DB_USER", "postgres").strip()
    if ref and user == "postgres":
        user = f"postgres.{ref}"
    return psycopg2.connect(
        host=os.getenv("BEANTHENTIC_DB_HOST"),
        port=int(os.getenv("BEANTHENTIC_DB_PORT", "5432")),
        user=user,
        password=os.getenv("BEANTHENTIC_DB_PASS", ""),
        dbname=os.getenv("BEANTHENTIC_DB_NAME", "postgres"),
        connect_timeout=20,
    )


def ensure_bucket_and_schema() -> None:
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(BUCKET_SQL)
            cur.execute(POLICY_SQL)
            try:
                cur.execute(ALTER_SQL)
            except Exception:
                pass
        conn.commit()
        print(f"Storage bucket '{BUCKET}' is ready (public read).")
    finally:
        conn.close()


def _resolve_photo_bytes(fid: int, stored: str) -> tuple[bytes, str] | None:
    """Load image bytes from DB value, related tables, local files, or Beanthentic-App."""
    from config.farmer_profile_photo import (
        fetch_farmer_photo_record,
        photo_record_to_bytes,
    )

    conn = _pg_connect()
    try:
        rec = fetch_farmer_photo_record(conn, fid)
        blob = photo_record_to_bytes(rec, fid)
        if blob:
            return blob
    finally:
        conn.close()

    if APP_ROOT.is_dir():
        try:
            sys.path.insert(0, str(APP_ROOT))
            from farmer_profile_storage import resolve_registration_photo_bytes  # noqa: E402

            legacy = resolve_registration_photo_bytes(fid, stored)
            if legacy:
                if isinstance(legacy, tuple):
                    return legacy
                return legacy, "image/jpeg"
        except Exception:
            pass
    return None


def backfill_farmers() -> None:
    key = beanthentic_env.supabase_service_role_key()
    if not key:
        print(
            "\nSkipping backfill: set BEANTHENTIC_SUPABASE_SERVICE_ROLE_KEY in .env "
            "(Supabase Dashboard -> Project Settings -> API -> service_role secret), then re-run."
        )
        return

    conn = _pg_connect()
    farmer_ids: list[int] = []
    stored_by_id: dict[int, str] = {}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT farmer_id, profile_photo FROM farmers ORDER BY farmer_id")
            for r in cur.fetchall():
                fid = int(r[0])
                farmer_ids.append(fid)
                stored_by_id[fid] = str(r[1] or "").strip()
    finally:
        conn.close()

    ok = skip = fail = no_photo = 0
    for fid in farmer_ids:
        stored = stored_by_id.get(fid, "")
        if stored.startswith("https://") and "supabase.co/storage/" in stored:
            name = Path(stored.split("/")[-1]).name
            if beanthentic_env.download_from_supabase_storage(name):
                skip += 1
                continue

        try:
            resolved = _resolve_photo_bytes(fid, stored)
        except Exception as exc:
            print(f"  farmer {fid}: could not load photo ({exc!s})")
            fail += 1
            continue
        if not resolved:
            print(f"  farmer {fid}: no photo in DB or local files — re-register with a selfie")
            no_photo += 1
            continue

        blob, mime = resolved
        ext = "jpg"
        if "png" in mime:
            ext = "png"
        elif "webp" in mime:
            ext = "webp"
        elif stored.lower().endswith(".png"):
            ext = "png"
        elif stored.lower().endswith(".webp"):
            ext = "webp"
        filename = f"farmer_{fid}.{ext}"
        public_url = beanthentic_env.upload_to_supabase_storage(blob, filename, mime)
        if not public_url:
            print(f"  farmer {fid}: upload failed (check service role key and bucket)")
            fail += 1
            continue
        conn = _pg_connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE farmers SET profile_photo = %s WHERE farmer_id = %s",
                    (public_url, fid),
                )
            conn.commit()
            print(f"  farmer {fid}: {public_url}")
            ok += 1
        finally:
            conn.close()

    print(
        f"\nBackfill done: {ok} uploaded, {skip} already on Supabase, "
        f"{no_photo} no source photo, {fail} failed."
    )


def main() -> int:
    print("Setting up Supabase profile-photos storage…")
    ensure_bucket_and_schema()
    backfill_farmers()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
