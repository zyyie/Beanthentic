#!/usr/bin/env python3
"""Reset local Beanthentic app data (JSON stores + upload folders).

Keeps:
  - data/users.json (admin accounts)
  - settings / .env
  - ML models and official training baselines
  - Farmer training CSV in machinelearning/uploads/

Usage (from project root):
  python scripts/wipe_app_data.py --yes
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
ML_UPLOADS = ROOT / "machinelearning" / "uploads"
GI_UPLOADS = ROOT / "uploads" / "gi_contributions"
KEEP_ML_NAMES = {
    "beanthentic_synthetic_dataset_1000 (1).csv",
}


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"  reset {path.relative_to(ROOT)}")


def _clear_dir(path: Path, *, keep_names: set[str] | None = None) -> int:
    if not path.exists():
        return 0
    keep_names = keep_names or set()
    removed = 0
    for item in path.iterdir():
        if item.name in keep_names:
            print(f"  keep  {item.relative_to(ROOT)}")
            continue
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink(missing_ok=True)
        removed += 1
    print(f"  cleared {removed} item(s) under {path.relative_to(ROOT)}")
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description="Wipe local Beanthentic app data")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation")
    args = parser.parse_args()

    if not args.yes:
        print("This resets local JSON stores and upload folders (keeps users.json).")
        if input("Type YES to continue: ").strip() != "YES":
            print("Cancelled.")
            raise SystemExit(0)

    print("Wiping local app data…")
    _write_json(DATA / "ipophl_documents.json", {})
    _write_json(
        DATA / "farmer_registration_cursor.json",
        {
            "initialized": False,
            "last_farmer_id": 0,
            "seen_ids": [],
            "notified_complete_ids": [],
        },
    )
    _write_json(DATA / "admin_notifications_feed.json", {
        "items": [],
        "dismissed_ids": [],
        "wipe_generation": int(__import__("time").time()),
    })
    _write_json(DATA / "otp_codes.json", {})
    tokens = DATA / "password_reset_tokens.json"
    if tokens.exists():
        tokens.unlink()
        print(f"  removed {tokens.relative_to(ROOT)}")

    photos = DATA / "profile_photos"
    if photos.exists():
        _clear_dir(photos)

    synthetic = DATA / "ipophl_synthetic_submission"
    if synthetic.exists():
        shutil.rmtree(synthetic)
        print(f"  removed {synthetic.relative_to(ROOT)}")

    ML_UPLOADS.mkdir(parents=True, exist_ok=True)
    _clear_dir(ML_UPLOADS, keep_names=KEEP_ML_NAMES)

    GI_UPLOADS.mkdir(parents=True, exist_ok=True)
    _clear_dir(GI_UPLOADS)

    print("Done. data/users.json was preserved.")


if __name__ == "__main__":
    main()
