"""
Admin Transactions API — reads approved/sent rows from beanthentic_app (same as app History).
"""

from __future__ import annotations

import json
import os
from datetime import date, datetime
from pathlib import Path
from urllib.request import Request, urlopen

from flask import jsonify, request
from pymysql.cursors import DictCursor

from config.app_connection import (
    app_db_params,
    app_server_base,
    clamp_limit,
    friendly_load_failure,
    load_error_payload,
)
from config.mysql_app_bridge import connect_app_mysql
from config.utils import is_authenticated


def _read_connection_settings() -> dict:
    try:
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
        conn = raw.get("connection")
        return conn if isinstance(conn, dict) else {}
    except Exception:
        return {}


def _app_db_params() -> dict | None:
    cfg = _read_connection_settings()
    host = os.getenv("BEANTHENTIC_APP_DB_HOST", "").strip() or str(cfg.get("app_db_host") or "").strip()
    if not host:
        return None
    return {
        "host": host,
        "port": int(os.getenv("BEANTHENTIC_APP_DB_PORT", str(cfg.get("app_db_port") or "3306"))),
        "user": os.getenv("BEANTHENTIC_APP_DB_USER", str(cfg.get("app_db_user") or "root")),
        "password": os.getenv("BEANTHENTIC_APP_DB_PASS", str(cfg.get("app_db_pass") or "")),
        "database": os.getenv("BEANTHENTIC_APP_DB_NAME", str(cfg.get("app_db_name") or "beanthentic_app")),
        "charset": "utf8mb4",
        "cursorclass": DictCursor,
        "autocommit": True,
    }


def _app_server_base() -> str:
    base = os.getenv("BEANTHENTIC_APP_SERVER_BASE", "").strip()
    if base:
        return base.rstrip("/")
    cfg = _read_connection_settings()
    return str(cfg.get("app_server_base") or "").strip().rstrip("/")


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
    params = app_db_params()
    if not params:
        raise RuntimeError("app_db_host not set in settings.json")
    conn = connect_app_mysql(params)
    try:
        sql = _TXN_SQL
        qparams: list = []
        if farmer_id and farmer_id > 0:
            sql += " AND ct.farmer_id = %s"
            qparams.append(int(farmer_id))
        sql += """
            ORDER BY COALESCE(approved_at, ct.transaction_date) DESC,
                     ct.customer_transaction_id DESC
            LIMIT %s
        """
        qparams.append(int(limit))
        with conn.cursor() as cur:
            cur.execute(sql, tuple(qparams))
            return _rows_to_items(cur.fetchall() or [])
    finally:
        conn.close()


def _load_from_app_http(limit: int, farmer_id: int | None) -> list[dict]:
    base = app_server_base()
    if not base:
        raise RuntimeError("app_server_base not set in settings.json")
    url = f"{base}/api/admin_customer_transactions.php?limit={int(limit)}"
    if farmer_id and farmer_id > 0:
        url += f"&farmer_id={int(farmer_id)}"
    req = Request(url, headers={"Accept": "application/json"})
    with urlopen(req, timeout=15) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    data = json.loads(raw) if raw else {}
    if not isinstance(data, dict) or data.get("ok") is not True:
        err = (data or {}).get("error") if isinstance(data, dict) else None
        raise RuntimeError(err or "Bad response from app server")
    items = data.get("items")
    return items if isinstance(items, list) else []


def load_admin_transactions(limit: int = 500, farmer_id: int | None = None) -> tuple[list[dict], str]:
    """MySQL first, HTTP fallback — never touches admin SQLAlchemy models."""
    limit = clamp_limit(limit or 500)
    if farmer_id is not None and farmer_id < 1:
        farmer_id = None
    mysql_err: Exception | None = None
    http_err: Exception | None = None

    try:
        return _load_from_mysql(limit, farmer_id), "app_mysql"
    except Exception as e:
        mysql_err = e

    try:
        return _load_from_app_http(limit, farmer_id), "app_server_http"
    except Exception as e:
        http_err = e

    raise RuntimeError(
        friendly_load_failure(
            module_label="transactions",
            mysql_error=mysql_err,
            http_error=http_err,
        )
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
