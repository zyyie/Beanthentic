"""Diagnose IPOPHL upload + GI Updates publish path."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: E402
from config.ipophl_store import list_documents  # noqa: E402
from config.supabase_client import get_client  # noqa: E402


def main() -> None:
    print("postgresql:", beanthentic_env.is_postgresql())
    print("uses_supabase_anon:", beanthentic_env.uses_supabase_anon())
    try:
        ok, msg = __import__("api.gi_contributions_api", fromlist=["probe_app_mysql"]).probe_app_mysql()
        print("probe_app_mysql:", ok, msg or "")
    except Exception as e:
        print("probe_app_mysql FAIL:", e)

    docs = list_documents(limit=5)
    print("local ipophl json docs:", len(docs))
    if docs:
        print(" sample:", docs[0].get("file_uuid"), docs[0].get("task_id"))

    c = get_client()
    try:
        gi = c.table("gi_updates").select("gi_update_id,category,current_phase,title", count="exact").eq("current_phase", "admin_submission").limit(5).execute()
        print("gi_updates admin_submission count:", gi.count, "sample:", gi.data[:2] if gi.data else [])
    except Exception as e:
        print("gi_updates REST FAIL:", e)

    try:
        da = c.table("document_analysis").select("file_uuid,task_id", count="exact").limit(5).execute()
        print("document_analysis count:", da.count, "sample:", da.data[:2] if da.data else [])
    except Exception as e:
        print("document_analysis REST FAIL:", e)

    try:
        farmers = c.table("farmers").select("farmer_id", count="exact").limit(3).execute()
        print("farmers count:", farmers.count)
    except Exception as e:
        print("farmers REST FAIL:", e)


if __name__ == "__main__":
    main()
