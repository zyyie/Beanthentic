#!/usr/bin/env python3
"""Backfill GCB/roasted classifications into production_information (Supabase/MySQL)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: F401
from config.mysql_app_bridge import connect_app_db
from config.production_fields import ensure_production_detail_columns
from config.supabase_production_sync import (
    backfill_production_classifications_from_detail,
    backfill_production_detail_from_legacy,
    upsert_production_detail,
)


def _load_import_rows(path: Path) -> list[dict]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    if isinstance(raw, dict):
        rows = raw.get("farmers") or raw.get("rows") or raw.get("production")
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    raise ValueError("Import JSON must be a list or {farmers|rows|production: [...]}")


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--import-json",
        type=Path,
        help="Optional JSON file: [{farmer_id, liberica_gcb_classification, ...}]",
    )
    args = parser.parse_args()

    conn = connect_app_db({})
    try:
        added = ensure_production_detail_columns(conn)
        if added:
            print(f"Added columns: {', '.join(added)}")

        qty_updated = backfill_production_detail_from_legacy(conn)
        print(f"Qty backfill updated rows: {qty_updated}")

        class_updated = backfill_production_classifications_from_detail(conn)
        print(f"Classification JSON flatten updated rows: {class_updated}")

        imported = 0
        if args.import_json:
            if not args.import_json.is_file():
                print(f"Import file not found: {args.import_json}", file=sys.stderr)
                return 1
            for row in _load_import_rows(args.import_json):
                fid = int(row.get("farmer_id") or 0)
                if fid < 1:
                    continue
                if upsert_production_detail(conn, fid, row):
                    imported += 1
            print(f"Imported production detail for {imported} farmer(s) from {args.import_json.name}")

        cur = conn.cursor()
        cur.execute(
            """
            SELECT COUNT(*) AS c FROM production_information
            WHERE COALESCE(liberica_gcb_classification, '') <> ''
               OR COALESCE(robusta_gcb_classification, '') <> ''
               OR COALESCE(excelsa_gcb_classification, '') <> ''
            """
        )
        cnt_row = cur.fetchone()
        with_class = cnt_row["c"] if hasattr(cnt_row, "get") else cnt_row[0]
        cur.close()
        print(f"Rows with at least one GCB classification: {with_class}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
