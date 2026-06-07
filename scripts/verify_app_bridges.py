#!/usr/bin/env python3
"""Verify Beanthentic-App HTTP bridges from settings.json. Run: python scripts/verify_app_bridges.py"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

BRIDGES = [
    ("admin_farmer_data.php", ""),
    ("admin_farmer_profile_photo.php", "farmer_id=1"),
    ("admin_farmer_photos.php", ""),
    ("admin_shared_messages.php", "role=admin&limit=2"),
    ("admin_customer_transactions.php", "limit=2"),
    ("admin_client_reports.php", "limit=2"),
    ("admin_gi_contributions.php", "limit=2"),
    ("admin_ipophl_documents.php", "action=list&limit=2"),
]


def main() -> int:
    from config.app_connection import app_server_base, prefer_app_http_bridge, read_connection_settings

    base = app_server_base()
    print("connection:", json.dumps(read_connection_settings(), indent=2))
    print("prefer_http_bridge:", prefer_app_http_bridge())
    if not base:
        print("ERROR: app_server_base not set")
        return 1

    ok_all = True
    for script, qs in BRIDGES:
        url = f"{base.rstrip('/')}/api/{script}"
        if qs:
            url += f"?{qs}"
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=10) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else {}
            ok = isinstance(data, dict) and data.get("ok") is True
            status = "OK" if ok else "BAD_RESPONSE"
            if not ok:
                ok_all = False
            print(f"  [{status}] {script}")
        except Exception as e:
            ok_all = False
            print(f"  [FAIL] {script} — {e}")

    if not ok_all:
        print("\nCopy missing files from Beanthentic/deploy/xampp_api/ to Beanthentic-App/api/ on the XAMPP PC.")
    return 0 if ok_all else 1


if __name__ == "__main__":
    raise SystemExit(main())
