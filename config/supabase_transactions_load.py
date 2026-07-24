"""Load approved customer transactions via Supabase REST."""

from __future__ import annotations

from config.supabase_client import get_client


def fetch_transactions_via_rest(limit: int = 500, farmer_id: int | None = None) -> list[dict]:
    limit = max(1, min(int(limit or 500), 2000))
    client = get_client()

    query = client.table("customer_transaction").select("*").order("transaction_date", desc=True).limit(limit)
    if farmer_id and farmer_id > 0:
        query = query.eq("farmer_id", int(farmer_id))
    txns = query.execute().data or []
    if not txns:
        return []

    txn_ids = [int(t["customer_transaction_id"]) for t in txns if t.get("customer_transaction_id")]
    farmer_ids = [int(t["farmer_id"]) for t in txns if t.get("farmer_id")]

    history_by_txn: dict[int, list[dict]] = {}
    if txn_ids:
        hist = (
            client.table("transaction_history")
            .select("customer_transaction_id,status,created_at,transaction_history_id")
            .in_("customer_transaction_id", txn_ids)
            .order("transaction_history_id")
            .execute()
            .data
            or []
        )
        for row in hist:
            tid = int(row.get("customer_transaction_id") or 0)
            history_by_txn.setdefault(tid, []).append(row)

    farmers_by_id: dict[int, dict] = {}
    if farmer_ids:
        frows = client.table("farmers").select("farmer_id,user_id,farm_code").in_("farmer_id", farmer_ids).execute().data or []
        for row in frows:
            farmers_by_id[int(row["farmer_id"])] = row

    user_ids = [int(f["user_id"]) for f in farmers_by_id.values() if f.get("user_id")]
    users_by_id: dict[int, dict] = {}
    if user_ids:
        urows = client.table("users").select("user_id,username,phone_number").in_("user_id", user_ids).execute().data or []
        for row in urows:
            users_by_id[int(row["user_id"])] = row

    pi_by_fid: dict[int, dict] = {}
    if farmer_ids:
        pirows = (
            client.table("personal_information")
            .select("farmer_id,first_name,last_name")
            .in_("farmer_id", farmer_ids)
            .execute()
            .data
            or []
        )
        for row in pirows:
            pi_by_fid[int(row["farmer_id"])] = row

    rows: list[dict] = []
    for txn in txns:
        tid = int(txn.get("customer_transaction_id") or 0)
        fid = int(txn.get("farmer_id") or 0)
        hist = history_by_txn.get(tid) or []
        current_status = (hist[-1].get("status") if hist else "") or ""
        status = str(current_status).strip().lower()
        if status not in ("approved", "sent_to_client"):
            continue
        approved_at = ""
        for entry in hist:
            if str(entry.get("status") or "").strip().lower() == "approved":
                approved_at = entry.get("created_at") or ""
                break
        farmer = farmers_by_id.get(fid) or {}
        user = users_by_id.get(int(farmer.get("user_id") or 0)) or {}
        pi = pi_by_fid.get(fid) or {}
        rows.append(
            {
                **txn,
                "farm_code": farmer.get("farm_code"),
                "username": user.get("username"),
                "phone_number": user.get("phone_number"),
                "first_name": pi.get("first_name"),
                "last_name": pi.get("last_name"),
                "current_status": status,
                "approved_at": approved_at,
            }
        )

    rows.sort(
        key=lambda r: (
            str(r.get("approved_at") or r.get("transaction_date") or ""),
            int(r.get("customer_transaction_id") or 0),
        ),
        reverse=True,
    )
    return rows[:limit]
