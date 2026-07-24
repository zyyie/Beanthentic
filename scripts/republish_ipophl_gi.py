#!/usr/bin/env python3
"""Republish all IPOPHL documents to every farmer's GI Updates feed."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import beanthentic_env  # noqa: E402

beanthentic_env.load_dotenv(ROOT / ".env")

from config.ipophl_store import list_documents  # noqa: E402
from api.gi_contributions_api import (  # noqa: E402
    publish_ipophl_registration_to_gi_updates,
    _list_active_farmer_ids,
)


def main() -> int:
    farmers = _list_active_farmer_ids()
    print(f"Farmers: {farmers}")
    docs = list_documents(limit=500)
    uuids = [str(d.get("file_uuid") or "").strip() for d in docs]
    uuids = [u for u in uuids if u]
    if not uuids:
        print("No IPOPHL documents found — upload files in admin IPOPHL first.")
        return 1
    print(f"Republishing {len(uuids)} file(s) to {len(farmers)} farmer(s)...")
    result = publish_ipophl_registration_to_gi_updates(
        file_uuids=uuids,
        publish_all_categories=False,
        replace_existing=True,
    )
    print(
        f"Done: {result.get('cards_published')} card(s), "
        f"{result.get('sent_count')} farmer broadcast(s), "
        f"source={result.get('source')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
