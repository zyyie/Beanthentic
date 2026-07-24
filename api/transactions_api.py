"""
Admin Transactions API — reads approved/sent rows from beanthentic_app (same as app History).
"""

from __future__ import annotations

from datetime import date, datetime

from flask import jsonify, request

from config.app_connection import app_db_params, clamp_limit, load_error_payload
from config.app_data_load import load_with_app_bridge
from config.app_http_bridge import app_http_get_json
from config.mysql_app_bridge import connect_app_db
import beanthentic_env
from config.utils import is_authenticated


def _dt_iso(val) -> str:
    if not val:
        return ""
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    return str(val)


def _normalize_variety(product: str) -> str:
    v = (product or "").strip().lower()
    if v in ("liberica", "excelsa", "robusta"):
        return v
    return v


def _farmer_name(r: dict) -> str:
    fn = (r.get("first_name") or "").strip()
    ln = (r.get("last_name") or "").strip()
    nm = (fn + " " + ln).strip()
    if nm:
        return nm
    return (r.get("username") or "").strip() or (r.get("phone_number") or "").strip() or "Farmer"


def _rows_to_items(rows: list) -> list[dict]:
    items = []
    for r in rows:
        qty = float(r.get("quantity") or 0)
        fid = int(r.get("farmer_id") or 0)
        farm_code = str(r.get("farm_code") or "").strip()
        farmer_no = farm_code if farm_code else (str(fid) if fid else "")
        at = r.get("approved_at") or r.get("transaction_date")
        status = str(r.get("current_status") or "approved").strip().lower()
        product_raw = str(r.get("product") or "").strip()
        variety = _normalize_variety(product_raw) or product_raw
        product_label = variety.capitalize() if variety in ("liberica", "excelsa", "robusta") else product_raw
        amount = float(r.get("amount") or 0)
        payment_amount = float(r.get("payment_amount") or 0)
        ref = str(r.get("reference_no") or "").strip()
        items.append(
            {
                "id": int(r.get("customer_transaction_id") or 0),
                "customer_transaction_id": int(r.get("customer_transaction_id") or 0),
                "farmer_id": fid,
                "farmer_no": farmer_no,
                "farmer_name": _farmer_name(r),
                "recorded_at": _dt_iso(at),
                "variety": variety,
                "product": product_label or variety or product_raw,
                "qty": abs(qty) if qty == int(qty) else abs(qty),
                "unit": "KG",
                "delta_kg": abs(qty),
                "amount": amount,
                "total": amount,
                "payment_amount": payment_amount,
                "payment_method": str(r.get("payment_method") or "Cash").strip() or "Cash",
                "change": max(0.0, payment_amount - amount),
                "reference_no": ref,
                "ref": ref,
                "buyer_name": str(r.get("buyer_name") or "").strip(),
                "notes": "",
                "recorded_by_phone": "",
                "status": status,
                "sent_to_client": status == "sent_to_client",
            }
        )
    return items


_TXN_SQL = """
    SELECT
      ct.customer_transaction_id,
      ct.farmer_id,
      ct.buyer_name,
      ct.product,
      ct.quantity,
      ct.amount,
      ct.payment_amount,
      ct.payment_method,
      ct.reference_no,
      ct.transaction_date,
      f.farm_code,
      u.username,
      u.phone_number,
      pi.first_name,
      pi.last_name,
      (
        SELECT th.status
        FROM transaction_history th
        WHERE th.customer_transaction_id = ct.customer_transaction_id
        ORDER BY th.transaction_history_id DESC
        LIMIT 1
      ) AS current_status,
      (
        SELECT th.created_at
        FROM transaction_history th
        WHERE th.customer_transaction_id = ct.customer_transaction_id
          AND th.status = 'approved'
        ORDER BY th.transaction_history_id ASC
        LIMIT 1
      ) AS approved_at
    FROM customer_transaction ct
    LEFT JOIN farmers f ON f.farmer_id = ct.farmer_id
    LEFT JOIN users u ON u.user_id = f.user_id
    LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
    WHERE (
      SELECT th.status
      FROM transaction_history th
      WHERE th.customer_transaction_id = ct.customer_transaction_id
      ORDER BY th.transaction_history_id DESC
      LIMIT 1
    ) IN ('approved', 'sent_to_client')
"""


def _load_from_mysql(limit: int, farmer_id: int | None) -> list[dict]:
    # Check if we're using PostgreSQL/Supabase first
    if beanthentic_env.is_postgresql():
        conn = connect_app_db({})
    else:
        params = app_db_params()
        if not params:
            raise RuntimeError("app_db_host not set in settings.json")
        conn = connect_app_db(params)

    try:
        # PostgreSQL does not allow SELECT aliases inside ORDER BY COALESCE(...).
        sql = f"SELECT * FROM ({_TXN_SQL.strip()}) AS txn WHERE 1=1"
        qparams: list = []
        if farmer_id and farmer_id > 0:
            sql += " AND txn.farmer_id = %s"
            qparams.append(int(farmer_id))
        sql += """
            ORDER BY COALESCE(txn.approved_at, txn.transaction_date) DESC,
                     txn.customer_transaction_id DESC
            LIMIT %s
        """
        qparams.append(int(limit))
        with conn.cursor() as cur:
            cur.execute(sql, tuple(qparams))
            return _rows_to_items(cur.fetchall() or [])
    finally:
        conn.close()


def _load_from_app_http(limit: int, farmer_id: int | None) -> list[dict]:
    query: dict = {"limit": int(limit)}
    if farmer_id and farmer_id > 0:
        query["farmer_id"] = int(farmer_id)
    data = app_http_get_json("/api/admin_customer_transactions.php", query=query, timeout=15)
    if not data.get("ok"):
        raise RuntimeError(str(data.get("error") or data.get("detail") or "Bad response from app server"))
    items = data.get("items")
    return items if isinstance(items, list) else []


def load_admin_transactions(limit: int = 500, farmer_id: int | None = None) -> tuple[list[dict], str]:
    """MySQL or HTTP bridge on the app device — never touches admin SQLAlchemy models."""
    limit = clamp_limit(limit or 500)
    if farmer_id is not None and farmer_id < 1:
        farmer_id = None

    if beanthentic_env.uses_supabase_anon():
        from config.supabase_transactions_load import fetch_transactions_via_rest

        rows = fetch_transactions_via_rest(limit=limit, farmer_id=farmer_id)
        return _rows_to_items(rows), "supabase_rest"

    return load_with_app_bridge(
        module_label="transactions",
        mysql_loader=lambda: _load_from_mysql(limit, farmer_id),
        http_loader=lambda: _load_from_app_http(limit, farmer_id),
    )


def register_transactions_routes(app) -> None:
    @app.route("/api/transactions-list", methods=["GET"])
    @app.route("/api/admin-transactions", methods=["GET"])
    def api_transactions_list():
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized", "items": []}), 401
        limit = clamp_limit(request.args.get("limit", type=int) or 500)
        farmer_id = request.args.get("farmer_id", type=int)
        try:
            items, source = load_admin_transactions(limit, farmer_id)
            return jsonify({"ok": True, "items": items, "count": len(items), "source": source})
        except Exception as e:
            payload = load_error_payload("TRANSACTIONS_LOAD_FAILED", str(e))
            return jsonify(payload), 503
