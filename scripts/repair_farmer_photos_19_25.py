#!/usr/bin/env python3
"""Ensure Supabase profile photos exist for farmers 19-25."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config.farmer_photo_repair import repair_farmer_photo_range  # noqa: E402


def main() -> int:
    results = repair_farmer_photo_range(19, 25, allow_generated=True)
    ok = 0
    for fid, (success, msg) in sorted(results.items()):
        status = "OK" if success else "FAIL"
        print(f"farmer {fid}: {status} — {msg}")
        if success:
            ok += 1
    print(f"\nRepaired {ok}/{len(results)} farmers.")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
