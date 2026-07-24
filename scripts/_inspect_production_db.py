#!/usr/bin/env python3
"""Temporary inspect script for production_information."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: F401
from config.mysql_app_bridge import connect_app_db

conn = connect_app_db()
cur = conn.cursor()
cur.execute(
    """
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'production_information'
    ORDER BY ordinal_position
    """
)
print("production_information columns:")
for row in cur.fetchall() or []:
    if isinstance(row, dict):
        print(f"  {row.get('column_name')}: {row.get('data_type')}")
    else:
        print(f"  {row}")

cur.execute(
    """
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY table_name
    """
)
print("\nall tables:")
for row in cur.fetchall() or []:
    name = row[0] if isinstance(row, (list, tuple)) else list(row.values())[0]
    if "prod" in str(name).lower() or "gcb" in str(name).lower() or "bean" in str(name).lower():
        print(f"  * {name}")
    else:
        print(f"    {name}")

cur.close()
conn.close()
