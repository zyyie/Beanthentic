#!/usr/bin/env python3
"""Remove admin-published GI Updates (admin_submission + admin_progress) from app MySQL."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config.app_connection import app_db_params
from config.mysql_app_bridge import connect_app_mysql


def main() -> None:
    params = app_db_params()
    if not params:
        raise SystemExit("app_db_host not set in settings.json")

    conn = connect_app_mysql(params)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM gi_updates WHERE current_phase IN ('admin_submission', 'admin_progress')"
            )
            deleted = int(cur.rowcount or 0)
            cur.execute("SELECT COUNT(*) AS c FROM gi_updates")
            row = cur.fetchone() or {}
            remaining = int(row.get("c") if isinstance(row, dict) else row[0] if row else 0)
        conn.commit()
        print(f"Deleted {deleted} admin GI update row(s).")
        print(f"Remaining gi_updates rows: {remaining}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
