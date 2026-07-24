
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import beanthentic_env
from config.supabase_client import verify_connection, public_config, get_client

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
