#!/usr/bin/env python3
"""Add production detail columns to production_information (Supabase / MySQL)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    from config.mysql_app_bridge import connect_app_db
    from config.production_fields import ensure_production_detail_columns
    import beanthentic_env

    conn = connect_app_db({})
    try:
        added = ensure_production_detail_columns(conn)
    finally:
        conn.close()

    if added:
        print(f"Added {len(added)} column(s): {', '.join(added)}")
    else:
        print("All production detail columns already present.")
    print("Backend:", "postgresql" if beanthentic_env.is_postgresql() else "mysql")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
