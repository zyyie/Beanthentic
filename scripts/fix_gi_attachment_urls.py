#!/usr/bin/env python3
"""Rewrite gi_updates attachment JSON to use absolute admin URLs."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: E402

beanthentic_env.load_dotenv(ROOT / ".env")

import psycopg2  # noqa: E402

ADMIN_BASE = beanthentic_env.admin_public_base().rstrip("/")
if not ADMIN_BASE:
    print("Set BEANTHENTIC_ADMIN_PUBLIC_BASE in .env first.")
    raise SystemExit(1)


def fix_attachments(raw: str | None) -> tuple[str | None, bool]:
    if not raw:
        return raw, False
    try:
        data = json.loads(raw)
    except Exception:
        return raw, False
    if not isinstance(data, list):
        return raw, False
    changed = False
    out = []
    for item in data:
        if not isinstance(item, dict):
            out.append(item)
            continue
        row = dict(item)
        path = str(row.get("path") or "").strip()
        url = str(row.get("url") or "").strip()
        if path and not path.startswith("/"):
            path = "/" + path.lstrip("/")
            row["path"] = path
            changed = True
        if path.startswith("/uploads/gi_contributions/"):
            full = f"{ADMIN_BASE}{path}"
            if url != full:
                row["url"] = full
                changed = True
        out.append(row)
    if not changed:
        return raw, False
    return json.dumps(out), True


def main() -> int:
    ref = beanthentic_env.supabase_project_ref()
    conn = psycopg2.connect(
        host=os.getenv("BEANTHENTIC_DB_HOST"),
        port=5432,
        user=f"postgres.{ref}",
        password=os.getenv("BEANTHENTIC_DB_PASS"),
        dbname="postgres",
    )
    updated = 0
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT gi_update_id, attachments_json FROM gi_updates WHERE attachments_json IS NOT NULL")
            for gid, raw in cur.fetchall():
                new_json, changed = fix_attachments(raw)
                if changed:
                    cur.execute(
                        "UPDATE gi_updates SET attachments_json = %s WHERE gi_update_id = %s",
                        (new_json, gid),
                    )
                    updated += 1
        conn.commit()
    finally:
        conn.close()
    print(f"Updated {updated} gi_updates row(s) with base {ADMIN_BASE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
