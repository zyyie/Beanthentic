#!/usr/bin/env python3
"""
Simulate browser Complete Registration (multipart + session).
Run while web.py is up: python scripts/test_complete_registration_manual.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from web import app  # noqa: E402
from config.ipophl_store import list_documents, bootstrap_orphan_uploads  # noqa: E402


def main() -> int:
    bootstrap_orphan_uploads(limit=500)
    docs = list_documents(limit=10)
    uuids = [str(d["file_uuid"]) for d in docs if d.get("file_uuid")][:3]
    entries = [
        {"file_uuid": u, "task_id": str(d.get("task_id") or "phase5-cert")}
        for u, d in zip(uuids, docs[: len(uuids)])
    ]

    with app.test_client() as client:
        with client.session_transaction() as sess:
            sess["user_phone"] = "9493380766"

        pre = client.get("/api/ipophl/publish-preflight")
        print("preflight", pre.status_code, pre.get_json())

        form = {
            "file_uuids_json": json.dumps(uuids),
            "file_entries_json": json.dumps(entries),
            "publish_all_categories": "false",
            "force_publish": "true",
        }
        res = client.post("/api/ipophl/complete-registration", data=form)
        data = res.get_json() or {}
        print("complete", res.status_code, "ok=", data.get("ok"), "cards=", data.get("cards_published"))
        if not data.get("ok"):
            print("error:", data.get("error"))
            print("detail:", data.get("detail"))
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
