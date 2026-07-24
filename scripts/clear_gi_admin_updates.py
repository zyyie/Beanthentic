#!/usr/bin/env python3
"""
Delete GI Updates from app MySQL (admin posts shown on mobile news.php).

Run from Beanthentic folder:
  python scripts/clear_gi_admin_updates.py
  python scripts/clear_gi_admin_updates.py --all
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config.app_connection import app_db_params
from config.mysql_app_bridge import connect_app_db
import beanthentic_env


def _count(cur, sql: str) -> int:
    cur.execute(sql)
    row = cur.fetchone()
    if isinstance(row, dict):
        return int(row.get("c") or row.get("COUNT(*)") or 0)
    if row:
        return int(row[0])
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Clear GI Updates in app MySQL/PostgreSQL")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Delete every row in gi_updates (admin + farmer submissions)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip confirmation prompt (not recommended)",
    )
    args = parser.parse_args()

    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
        host = "Supabase/PostgreSQL"
        db = beanthentic_env.get_db_config().get("dbname", "?")
        print(f"Connecting to PostgreSQL {host} / {db} ...")
    else:
        params = app_db_params()
        if not params:
            print("ERROR: settings.json has no connection.app_db_host")
            print(f"Edit: {ROOT / 'settings.json'}")
            raise SystemExit(1)
        conn = connect_app_db(params)
        host = params.get("host", "?")
        db = params.get("database", "?")
        print(f"Connecting to MySQL {host} / {db} ...")

    scope = "ALL gi_updates rows" if args.all else "admin_submission + admin_progress rows"
    if not args.yes:
        print(f"\nWARNING: This will DELETE {scope} on {host}/{db}.")
        print("Mobile GI Updates will appear empty until admin clicks Complete Registration again.")
        answer = input("Type YES to continue: ").strip()
        if answer != "YES":
            print("Cancelled.")
            raise SystemExit(0)

    try:
        with conn.cursor() as cur:
            before = _count(cur, "SELECT COUNT(*) AS c FROM gi_updates")
            if args.all:
                cur.execute("DELETE FROM gi_updates")
            else:
                cur.execute(
                    "DELETE FROM gi_updates "
                    "WHERE current_phase IN ('admin_submission', 'admin_progress')"
                )
            deleted = int(cur.rowcount or 0)
            after = _count(cur, "SELECT COUNT(*) AS c FROM gi_updates")
        conn.commit()
    except Exception as exc:
        try:
            conn.rollback()
        except Exception:
            pass
        print(f"ERROR during delete: {exc}")
        raise SystemExit(1) from exc
    finally:
        conn.close()

    print(f"Deleted {deleted} row(s). gi_updates: {before} -> {after}")
    print("Done. Refresh GI Updates on the mobile app (close and reopen the page).")


if __name__ == "__main__":
    main()
