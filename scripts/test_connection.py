#!/usr/bin/env python3
"""Quick Supabase + transactions connectivity check."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: E402
from config.supabase_client import verify_connection, public_config, get_client  # noqa: E402


def main() -> None:
    print("Testing Supabase anon connection...")
    ok, err = verify_connection()
    print(f"  Supabase REST: {'OK' if ok else f'ERROR - {err}'}")

    cfg = public_config()
    print(f"  URL: {cfg.get('supabase_url')}")
    print(f"  Anon key: {'(set)' if cfg.get('supabase_anon_key') else '(missing)'}")

    if ok:
        farmers = get_client().table("farmers").select("farmer_id").execute()
        print(f"  Farmers via anon: {len(farmers.data or [])}")

    print("\nTesting load_admin_transactions...")
    try:
        from api.transactions_api import load_admin_transactions

        items, source = load_admin_transactions(limit=10)
        print(f"  Success! Loaded {len(items)} transactions from {source}")
    except Exception as e:
        print(f"  ERROR: {e}")


if __name__ == "__main__":
    main()
