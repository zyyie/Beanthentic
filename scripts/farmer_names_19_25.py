"""Query farmer names for 19-25."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config.supabase_client import get_client  # noqa: E402

c = get_client()
for fid in range(19, 26):
    pi = (
        c.table("personal_information")
        .select("first_name,last_name,middle_name")
        .eq("farmer_id", fid)
        .limit(1)
        .execute()
        .data
        or []
    )
    if pi:
        r = pi[0]
        name = f"{r.get('first_name','')} {r.get('middle_name','') or ''} {r.get('last_name','')}".replace("  ", " ").strip()
        print(fid, name)
    else:
        print(fid, "(no personal_information)")
