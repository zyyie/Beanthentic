#!/usr/bin/env python3
"""Run from Beanthentic folder: python scripts/diagnose_gi_connection.py"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    from api.gi_contributions_api import (
        _count_admin_gi_rows,
        _list_active_farmer_ids,
        check_xampp_for_publish,
        probe_app_mysql,
        probe_gi_app_server,
    )
    from config.app_connection import app_db_params, app_server_base, read_connection_settings

    conn = read_connection_settings()
    print("=== Beanthentic GI connection diagnostic ===\n")
    print("settings.json connection:")
    print(json.dumps(conn, indent=2))
    print()

    mysql_ok, mysql_err = probe_app_mysql()
    http_ok, http_base, http_err = probe_gi_app_server()
    pre = check_xampp_for_publish()

    print(f"app_db_host configured: {bool(app_db_params())}")
    print(f"app_server_base: {app_server_base() or '(not set)'}")
    print(f"MySQL reachable: {mysql_ok}" + (f" — {mysql_err}" if not mysql_ok else ""))
    print(f"HTTP :8080 reachable: {http_ok}" + (f" @ {http_base}" if http_ok else f" — {http_err}"))
    print(f"Can publish (preflight ok): {pre.get('ok')}")
    print()

    if app_db_params():
        try:
            farmers = _list_active_farmer_ids()
            print(f"Active farmers: {farmers}")
            print(f"admin_submission rows in gi_updates: {_count_admin_gi_rows()}")
        except Exception as e:
            print(f"Farmer/row check failed: {e}")
    else:
        print("Set app_db_host in settings.json or /connection-settings")

    print("\nPhone must use the SAME host as app_server_base (port 8080), not admin :5000.")
    return 0 if pre.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
