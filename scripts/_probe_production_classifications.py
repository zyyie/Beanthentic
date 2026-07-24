#!/usr/bin/env python3
"""Probe Supabase/Postgres for bean classification data."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: F401
from config.mysql_app_bridge import connect_app_db

TERMS = (
    "small_beans",
    "medium_beans",
    "large_beans",
    "ground_beans",
    "whole_beans",
    "Small Beans",
    "Medium Beans",
    "Large Beans",
    "Ground Beans",
    "Whole Beans",
)


def main() -> int:
    conn = connect_app_db({})
    cur = conn.cursor()
    cur.execute(
        """
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        ORDER BY table_name
        """
    )
    tables = [r["table_name"] if hasattr(r, "get") else r[0] for r in cur.fetchall() or []]
    print(f"tables: {len(tables)}")

    hits: list[str] = []
    for table in tables:
        cur.execute(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = %s
            """,
            (table,),
        )
        for row in cur.fetchall() or []:
            col = row["column_name"] if hasattr(row, "get") else row[0]
            dtype = (row["data_type"] if hasattr(row, "get") else row[1] or "").lower()
            if "class" in col.lower() or "gcb" in col.lower() or "roast" in col.lower():
                try:
                    cur.execute(
                        f"SELECT COUNT(*) AS c FROM {table} WHERE {col} IS NOT NULL AND CAST({col} AS TEXT) <> ''"
                    )
                    cnt_row = cur.fetchone()
                    cnt = cnt_row["c"] if hasattr(cnt_row, "get") else cnt_row[0]
                    if cnt:
                        hits.append(f"{table}.{col}: {cnt} non-null")
                except Exception:
                    conn.rollback()
            if dtype in ("character varying", "text", "varchar", "character", "json", "jsonb"):
                for term in TERMS:
                    try:
                        cur.execute(
                            f"SELECT COUNT(*) AS c FROM {table} WHERE CAST({col} AS TEXT) ILIKE %s",
                            (f"%{term}%",),
                        )
                        cnt_row = cur.fetchone()
                        cnt = cnt_row["c"] if hasattr(cnt_row, "get") else cnt_row[0]
                        if cnt:
                            hits.append(f"{table}.{col} ~ '{term}': {cnt}")
                    except Exception:
                        conn.rollback()

    if hits:
        print("HITS:")
        for h in hits:
            print(" ", h)
    else:
        print("No classification text found in any table.")

    cur.execute(
        """
        SELECT farmer_id, liberica_gcb_classification, robusta_gcb_classification,
               excelsa_gcb_classification, liberica_roasted_classification,
               robusta_roasted_classification, excelsa_roasted_classification,
               liberica_qty_kg, robusta_qty_kg, excelsa_qty_kg
        FROM production_information
        ORDER BY farmer_id
        LIMIT 5
        """
    )
    print("\nSample production_information:")
    for row in cur.fetchall() or []:
        print(row)

    cur.close()
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
