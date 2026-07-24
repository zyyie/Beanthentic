#!/usr/bin/env python3
"""Verify production_information detail columns exist in Supabase/MySQL."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

EXPECTED = [
    "liberica_harvest_qty_kg",
    "robusta_harvest_qty_kg",
    "excelsa_harvest_qty_kg",
    "liberica_gcb_classification",
    "liberica_gcb_qty_kg",
    "robusta_gcb_classification",
    "robusta_gcb_qty_kg",
    "excelsa_gcb_classification",
    "excelsa_gcb_qty_kg",
    "liberica_roasted_classification",
    "liberica_roasted_qty_kg",
    "robusta_roasted_classification",
    "robusta_roasted_qty_kg",
    "excelsa_roasted_classification",
    "excelsa_roasted_qty_kg",
]


def main() -> int:
    import beanthentic_env
    from config.mysql_app_bridge import connect_app_db

    conn = connect_app_db({})
    cur = conn.cursor()
    if beanthentic_env.is_postgresql():
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'production_information'
            """
        )
    else:
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'production_information'
            """
        )
    cols = {str(r.get("column_name") if hasattr(r, "get") else r[0]) for r in (cur.fetchall() or [])}
    conn.close()

    missing = [c for c in EXPECTED if c not in cols]
    present = [c for c in EXPECTED if c in cols]
    print(f"production_information: {len(present)}/{len(EXPECTED)} detail columns present")
    if present:
        print("Present:", ", ".join(present))
    if missing:
        print("MISSING:", ", ".join(missing))
        return 1
    print("OK — all production detail columns verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
