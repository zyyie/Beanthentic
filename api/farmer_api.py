"""
Farmer data API endpoints for Beanthentic application.

Provides endpoints for farmer data, picker lists, and coffee transactions.
"""

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from flask import jsonify, request
import pymysql
from pymysql.cursors import DictCursor

from config.farmer_moderation import (
    apply_suspend,
    apply_unsuspend,
    apply_warning,
    ensure_farmer_mod_columns,
    farmer_account_status,
)
from config.models import Farmer, FarmerCoffeeTransaction, db
from config.mysql_app_bridge import connect_app_mysql
from config.ownership import ownership_columns, resolve_ownership_status
from config.security import api_error, safe_error_message
from config.validation import (
    FARMER_ACCOUNT_ACTIONS,
    PAYMENT_METHODS,
    REASON_MAX,
    clean_text,
    validate_decimal_range,
    validate_enum,
    validate_positive_int,
)
from config.utils import get_current_user_phone, is_authenticated, log_activity


def _app_db_params() -> dict | None:
    """
    Optional "remote app DB" bridge.

    If BEANTHENTIC_APP_DB_HOST is set, dashboard farmer data will be sourced from
    the Beanthentic-App XAMPP MySQL schema (beanthentic_app) instead of this
    website's SQLAlchemy Farmer model.
    """
    host = os.getenv("BEANTHENTIC_APP_DB_HOST", "").strip()
    if not host:
        cfg = _read_connection_settings()
        host = str(cfg.get("app_db_host") or "").strip()
    if not host:
        return None
    cfg = _read_connection_settings()
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


def _read_connection_settings() -> dict:
    try:
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
        conn = raw.get("connection")
        return conn if isinstance(conn, dict) else {}
    except Exception:
        return {}


def _app_server_base() -> str:
    base = os.getenv("BEANTHENTIC_APP_SERVER_BASE", "").strip()
    if base:
        return base.rstrip("/")
    cfg = _read_connection_settings()
    base = str(cfg.get("app_server_base") or "").strip()
    return base.rstrip("/") if base else ""


def _app_shared_db_configured() -> bool:
    """True when admin should use Beanthentic-App MySQL / HTTP (not legacy admin-only tables)."""
    if _app_db_params() or _app_server_base():
        return True
    conn = _read_connection_settings()
    return bool(str(conn.get("app_db_host") or "").strip()) or bool(
        str(conn.get("app_server_base") or "").strip()
    )


def _load_dashboard_transactions(limit: int, farmer_id: int | None = None) -> tuple[list[dict], str, list[str]]:
    """
    Load approved/sent customer transactions (same as app Transaction History).
    Direct MySQL first (same as farmer register), then HTTP app server fallback.
    """
    errors: list[str] = []

    if _app_db_params():
        try:
            return _list_app_customer_transactions(limit, farmer_id), "app_mysql", errors
        except Exception as e:
            errors.append(f"MySQL: {e}")

    if _app_server_base():
        http_items, http_err = _fetch_customer_transactions_via_app_server(limit, farmer_id)
        if http_items is not None:
            return http_items, "app_server_http", errors
        if http_err:
            errors.append(f"HTTP: {http_err}")

    return [], "app_mysql", errors


def admin_transactions_get_response(limit: int = 400, farmer_id: int | None = None):
    """Shared GET handler for admin Transactions table (app DB history)."""
    try:
        limit = min(max(int(limit or 400), 1), 800)
    except (TypeError, ValueError):
        limit = 400

    if _app_shared_db_configured():
        try:
            items, source, errors = _load_dashboard_transactions(limit, farmer_id)
            if items or not errors:
                return jsonify(
                    {
                        "items": items,
                        "source": source,
                        "count": len(items),
                    }
                )
            detail = "; ".join(errors) if errors else "Could not load transactions."
            return (
                jsonify(
                    {
                        "error": "APP_DB_UNREACHABLE",
                        "detail": detail,
                        "items": [],
                        "source": source,
                        "hint": "Check app_db_host in settings.json (XAMPP LAN IP). Restart admin web after code updates.",
                    }
                ),
                503,
            )
        except Exception as e:
            return (
                jsonify(
                    {
                        "error": "TRANSACTIONS_LOAD_FAILED",
                        "detail": str(e),
                        "items": [],
                    }
                ),
                500,
            )

    try:
        balance_after = _coffee_balance_after_by_txn_id_legacy()
        q = FarmerCoffeeTransaction.query
        if farmer_id:
            q = q.filter(FarmerCoffeeTransaction.farmer_id == farmer_id)
        rows = (
            q.order_by(
                FarmerCoffeeTransaction.recorded_at.desc(),
                FarmerCoffeeTransaction.id.desc(),
            )
            .limit(limit)
            .all()
        )
        farmer_cache = {}
        items = []
        for tx in rows:
            f = farmer_cache.get(tx.farmer_id)
            if f is None:
                f = db.session.get(Farmer, tx.farmer_id)
                if f:
                    farmer_cache[tx.farmer_id] = f
            v = _normalize_coffee_variety(tx.variety) or (tx.variety or "").lower()
            items.append(
                {
                    "id": tx.id,
                    "farmer_id": tx.farmer_id,
                    "farmer_no": f.no if f else None,
                    "farmer_name": f.name if f else "",
                    "recorded_at": tx.recorded_at.isoformat() if tx.recorded_at else "",
                    "variety": v,
                    "delta_kg": float(tx.delta_kg or 0),
                    "balance_after_kg": balance_after.get(tx.id),
                    "payment_amount": float(tx.payment_amount or 0) if tx.payment_amount else 0,
                    "payment_method": tx.payment_method or "",
                    "reference_no": tx.reference_no or "",
                    "buyer_name": (tx.buyer_name or "").strip(),
                    "notes": (tx.notes or "").strip(),
                    "recorded_by_phone": (tx.recorded_by_phone or "").strip(),
                }
            )
        return jsonify({"items": items, "source": "admin_db"})
    except Exception as legacy_err:
        return (
            jsonify(
                {
                    "error": "LEGACY_TRANSACTIONS_UNAVAILABLE",
                    "detail": str(legacy_err),
                    "items": [],
                    "hint": "Configure connection.app_db_host in settings.json to use app transaction history.",
                }
            ),
            503,
        )


def _coffee_balance_after_by_txn_id_legacy():
    """Legacy admin SQLite ledger balance (optional)."""
    rows = FarmerCoffeeTransaction.query.order_by(
        FarmerCoffeeTransaction.recorded_at.asc(),
        FarmerCoffeeTransaction.id.asc(),
    ).all()
    balances = {}
    running_balance = 0
    for tx in rows:
        running_balance += float(tx.delta_kg or 0)
        balances[tx.id] = running_balance
    return balances


def _fetch_ownership_supplement_via_app_server() -> dict | None:
    """Load SQLite-backed ownership map from Beanthentic-App (port 8080)."""
    base = _app_server_base()
    if not base:
        return None
    url = base + "/api/farmer-ownership-supplement.php"
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw) if raw else None
        if isinstance(data, dict) and data.get("ok") is True:
            return data
    except (HTTPError, URLError, TimeoutError, ValueError):
        pass
    return None


def _fetch_farmer_data_via_app_server() -> tuple[list[dict] | None, str | None]:
    base = _app_server_base()
    if not base:
        return None, "APP_SERVER_BASE_NOT_SET"
    url = base + "/api/admin_farmer_data.php"
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=8) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw) if raw else None
        if not isinstance(data, dict) or data.get("ok") is not True:
            return None, "BAD_RESPONSE_FROM_APP_SERVER"
        items = data.get("items")
        return (items if isinstance(items, list) else []), None
    except (HTTPError, URLError, TimeoutError, ValueError) as e:
        return None, str(e)


def _fetch_customer_transactions_via_app_server(
    limit: int, farmer_id: int | None = None
) -> tuple[list[dict] | None, str | None]:
    """When admin PC cannot reach MySQL directly, use Beanthentic-App HTTP API on XAMPP device."""
    base = _app_server_base()
    if not base:
        return None, "APP_SERVER_BASE_NOT_SET"
    limit = max(1, min(int(limit or 400), 800))
    url = f"{base}/api/admin_customer_transactions.php?limit={limit}"
    if farmer_id:
        url += f"&farmer_id={int(farmer_id)}"
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=12) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw) if raw else None
        if not isinstance(data, dict) or data.get("ok") is not True:
            err = (data or {}).get("error") if isinstance(data, dict) else None
            return None, err or "BAD_RESPONSE_FROM_APP_SERVER"
        items = data.get("items")
        return (items if isinstance(items, list) else []), None
    except HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
            parsed = json.loads(body) if body else {}
            if isinstance(parsed, dict) and parsed.get("error"):
                return None, str(parsed.get("error"))
        except Exception:
            pass
        return None, f"HTTP {e.code}"
    except (URLError, TimeoutError, ValueError) as e:
        return None, str(e)


def _ensure_ownership_varchar(conn) -> None:
    """Allow wizard values in farm_information.ownership_status (ENUM drops landowner, etc.)."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COLUMN_TYPE FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'farm_information'
                  AND COLUMN_NAME = 'ownership_status'
                LIMIT 1
                """
            )
            row = cur.fetchone() or {}
            col_type = str(row.get("COLUMN_TYPE") or "").lower()
            if "enum" in col_type:
                cur.execute(
                    "ALTER TABLE farm_information MODIFY ownership_status VARCHAR(40) NULL"
                )
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass


def _app_db_connect():
    params = _app_db_params()
    if not params:
        return None
    return connect_app_mysql(params)


def _normalize_coffee_variety(variety):
    """Normalize coffee variety names."""
    if not variety:
        return None
    v = str(variety).strip().lower()
    if v in ("liberica", "excelsa", "robusta"):
        return v
    return v or None


def _farmer_display_name_from_row(r: dict) -> str:
    fn = (r.get("first_name") or "").strip()
    ln = (r.get("last_name") or "").strip()
    nm = (fn + " " + ln).strip()
    if nm:
        return nm
    return (r.get("username") or "").strip() or (r.get("phone_number") or "").strip()


def _dt_iso(val) -> str:
    if not val:
        return ""
    if isinstance(val, datetime):
        return val.isoformat()
    return str(val)


def _list_app_customer_transactions(limit: int, farmer_id: int | None = None) -> list[dict]:
    """
    Same approved/sent rows as the farmer app Transaction History (customer_transaction + transaction_history).
    """
    conn = _app_db_connect()
    if not conn:
        raise RuntimeError("APP_DB_NOT_CONFIGURED")

    limit = max(1, min(int(limit or 400), 800))
    sql = """
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
    params: list = []
    if farmer_id:
        sql += " AND ct.farmer_id = %s"
        params.append(int(farmer_id))
    sql += """
        ORDER BY COALESCE(approved_at, ct.transaction_date) DESC, ct.customer_transaction_id DESC
        LIMIT %s
    """
    params.append(limit)

    items: list[dict] = []
    try:
        with conn.cursor() as cur:
            cur.execute(sql, tuple(params))
            rows = cur.fetchall() or []
        for r in rows:
            qty = float(r.get("quantity") or 0)
            fid = int(r.get("farmer_id") or 0)
            farm_code = (r.get("farm_code") or "").strip()
            farmer_no = farm_code if farm_code else (str(fid) if fid else "")
            product_raw = str(r.get("product") or "").strip()
            variety = _normalize_coffee_variety(product_raw) or product_raw.lower()
            product_label = variety.capitalize() if variety in ("liberica", "excelsa", "robusta") else product_raw
            at = r.get("approved_at") or r.get("transaction_date")
            status = str(r.get("current_status") or "approved").strip().lower()
            amount = float(r.get("amount") or 0)
            pay_amt = float(r.get("payment_amount") or 0)
            ref = str(r.get("reference_no") or "").strip()
            items.append(
                {
                    "id": int(r.get("customer_transaction_id") or 0),
                    "customer_transaction_id": int(r.get("customer_transaction_id") or 0),
                    "farmer_id": fid,
                    "farmer_no": farmer_no,
                    "farmer_name": _farmer_display_name_from_row(r),
                    "recorded_at": _dt_iso(at),
                    "variety": variety,
                    "product": product_label or product_raw,
                    "qty": int(abs(qty)) if abs(qty) == int(abs(qty)) else abs(qty),
                    "unit": "KG",
                    "delta_kg": abs(qty),
                    "amount": amount,
                    "total": amount,
                    "payment_amount": pay_amt,
                    "payment_method": (r.get("payment_method") or "Cash") or "Cash",
                    "change": max(0.0, pay_amt - amount),
                    "reference_no": ref,
                    "ref": ref,
                    "buyer_name": (r.get("buyer_name") or "").strip(),
                    "notes": "",
                    "recorded_by_phone": "",
                    "status": status,
                    "sent_to_client": status == "sent_to_client",
                }
            )
        return items
    finally:
        conn.close()


def _fmt_birthday(value) -> str:
    """Format personal_information.birthday for dashboard display."""
    if value is None or value == "":
        return ""
    if isinstance(value, (datetime, date)):
        return value.strftime("%Y-%m-%d")
    return str(value).strip()


def _rsbsa_label_from_db(val) -> str:
    """Map affiliation_information.rsbsa_registered (0=no, 1=yes, 2=pending)."""
    try:
        iv = int(val or 0)
    except (TypeError, ValueError):
        return "No"
    if iv == 1:
        return "Yes"
    if iv == 2:
        return "Pending"
    return "No"


def _ncfrs_label(val) -> str:
    return "Yes" if int(val or 0) == 1 else "No"


def _rsbsa_status_label(raw) -> str:
    s = str(raw or "").strip().lower()
    if s == "not_yet_applied":
        return "Not Yet Applied"
    if s == "pending_rsbsa":
        return "Pending RSBSA"
    return ""


def _app_fetch_farmer_rows(limit: int = 2000) -> list[dict]:
    """
    Fetch farmer dataset from XAMPP MySQL schema used by Beanthentic-App.
    Returns dict rows ready to map to dashboard keys.
    """
    conn = _app_db_connect()
    if not conn:
        return []
    limit = max(1, min(int(limit or 2000), 5000))
    sql = """
      SELECT
        f.farmer_id,
        u.user_id,
        u.username,
        u.phone_number,
        u.email AS user_email,
        f.status,
        pi.first_name,
        pi.last_name,
        pi.contact_number,
        pi.birthday,
        COALESCE(pi.barangay, fi.barangay) AS barangay,
        fi.ownership_status,
        fi.farm_size_ha,
        ai.federation_assoc,
        ai.ncfrs,
        ai.rsbsa_registered,
        ai.rsbsa_number,
        ai.rsbsa_status,
        tc.robusta_bearing,
        tc.robusta_non_bearing,
        tc.liberica_bearing,
        tc.liberica_non_bearing,
        tc.excelsa_bearing,
        tc.excelsa_non_bearing,
        prod.robusta_qty_kg,
        prod.liberica_qty_kg,
        prod.excelsa_qty_kg,
        f.is_suspended,
        f.suspended_until,
        f.suspension_reason,
        f.warning_count,
        f.last_warning_at,
        f.last_warning_reason
      FROM farmers f
      LEFT JOIN users u ON u.user_id = f.user_id
      LEFT JOIN personal_information pi ON pi.farmer_id = f.farmer_id
      LEFT JOIN farm_information fi ON fi.farmer_id = f.farmer_id
      LEFT JOIN affiliation_information ai ON ai.farmer_id = f.farmer_id
      LEFT JOIN tree_counts tc
        ON tc.farmer_id = f.farmer_id
       AND tc.record_year = (
          SELECT MAX(t2.record_year) FROM tree_counts t2 WHERE t2.farmer_id = f.farmer_id
        )
      LEFT JOIN production_information prod
        ON prod.farmer_id = f.farmer_id
       AND prod.production_year = (
          SELECT MAX(p2.production_year) FROM production_information p2 WHERE p2.farmer_id = f.farmer_id
        )
      ORDER BY f.farmer_id ASC
      LIMIT %s
    """
    try:
        _ensure_ownership_varchar(conn)
        ensure_farmer_mod_columns(conn)
        with conn.cursor() as cur:
            cur.execute(sql, (limit,))
            rows = cur.fetchall() or []
            return list(rows)
    finally:
        conn.close()


def register_farmer_routes(app):
    """Register farmer-related API routes with the Flask app."""

    @app.route("/api/app-db-status", methods=["GET"])
    def api_app_db_status():
        """
        LAN/dev diagnostic: verify admin web can reach the Beanthentic-App MySQL
        and show row counts. Open in browser when farmer table is empty.
        """
        if not is_authenticated():
            return jsonify({"error": "Unauthorized", "message": "Admin login required."}), 401

        params = _app_db_params()
        if not params:
            return jsonify(
                {
                    "ok": False,
                    "configured": False,
                    "hint": "Set connection in settings.json or BEANTHENTIC_APP_DB_* env vars.",
                }
            ), 200

        out = {
            "ok": False,
            "configured": True,
            "host": params["host"],
            "port": params["port"],
            "database": params["database"],
            "user": params["user"],
        }
        conn = None
        try:
            conn = connect_app_mysql(params)
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) AS c FROM farmers")
                out["farmers_count"] = int((cur.fetchone() or {}).get("c") or 0)
                cur.execute("SELECT COUNT(*) AS c FROM users")
                out["users_count"] = int((cur.fetchone() or {}).get("c") or 0)
                cur.execute("SELECT COUNT(*) AS c FROM personal_information")
                out["personal_information_count"] = int((cur.fetchone() or {}).get("c") or 0)
                cur.execute(
                    """
                    SELECT COUNT(*) AS c FROM farmers f
                    INNER JOIN users u ON u.user_id = f.user_id
                    """
                )
                out["farmers_with_matching_user"] = int((cur.fetchone() or {}).get("c") or 0)
                cur.execute(
                    """
                    SELECT COUNT(*) AS c FROM farmers f
                    LEFT JOIN users u ON u.user_id = f.user_id
                    WHERE u.user_id IS NULL
                    """
                )
                out["farmers_missing_user_row"] = int((cur.fetchone() or {}).get("c") or 0)
                cur.execute(
                    """
                    SELECT COUNT(*) AS c FROM customer_transaction ct
                    WHERE (
                      SELECT th.status FROM transaction_history th
                      WHERE th.customer_transaction_id = ct.customer_transaction_id
                      ORDER BY th.transaction_history_id DESC LIMIT 1
                    ) IN ('approved', 'sent_to_client')
                    """
                )
                out["app_transactions_history_count"] = int((cur.fetchone() or {}).get("c") or 0)
            out["ok"] = True
            return jsonify(out), 200
        except Exception as e:
            out["error"] = safe_error_message(e, public="Could not connect to app database.")
            out["hint"] = "Check app_db_host in settings.json (XAMPP LAN IP) and MySQL remote access."
            return jsonify(out), 200
        finally:
            if conn:
                conn.close()

    @app.route("/api/farmer-data", methods=["GET"])
    def api_farmer_data():
        """Provide farmer data for dashboard from XAMPP beanthentic_app."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized", "message": "Admin login required."}), 401

        app_db = _app_db_params()
        if not app_db:
            items, err = _fetch_farmer_data_via_app_server()
            if items is not None:
                return jsonify(items)
            return jsonify(
                {
                    "error": "APP_DB_NOT_CONFIGURED",
                    "detail": "Set Beanthentic/settings.json connection.app_db_host (and optionally app_server_base).",
                    "fallback_error": err,
                }
            ), 503

        try:
            rows = _app_fetch_farmer_rows(limit=2500)
        except Exception as e:
            items, err = _fetch_farmer_data_via_app_server()
            if items is not None:
                return jsonify(items)
            return jsonify(
                {
                    "error": "APP_DB_UNREACHABLE",
                    "detail": safe_error_message(e),
                    "fallback_error": err,
                }
            ), 503

        supplement = _fetch_ownership_supplement_via_app_server() or {}
        sqlite_by_name = supplement.get("by_name") if isinstance(supplement.get("by_name"), dict) else {}
        sqlite_by_phone = supplement.get("by_phone") if isinstance(supplement.get("by_phone"), dict) else {}
        sqlite_by_email = supplement.get("by_email") if isinstance(supplement.get("by_email"), dict) else {}

        out = []
        for r in rows:
            first = (r.get("first_name") or "").strip()
            last = (r.get("last_name") or "").strip()
            legal_name = (first + " " + last).strip()
            display = legal_name
            if not display:
                display = (r.get("username") or "").strip()
            if not display:
                display = (r.get("phone_number") or "").strip()
            if not display:
                display = f"Farmer #{int(r.get('farmer_id') or 0)}"

            rb = int(r.get("robusta_bearing") or 0)
            rn = int(r.get("robusta_non_bearing") or 0)
            lb = int(r.get("liberica_bearing") or 0)
            ln = int(r.get("liberica_non_bearing") or 0)
            eb = int(r.get("excelsa_bearing") or 0)
            en = int(r.get("excelsa_non_bearing") or 0)

            own_raw = resolve_ownership_status(
                r.get("ownership_status"),
                first_name=first,
                last_name=last,
                phone=(r.get("phone_number") or ""),
                email=(r.get("user_email") or ""),
                sqlite_by_name=sqlite_by_name,
                sqlite_by_phone=sqlite_by_phone,
                sqlite_by_email=sqlite_by_email,
            )
            own_flags = ownership_columns(own_raw)

            phone_raw = (r.get("phone_number") or r.get("contact_number") or "").strip()

            fid = int(r.get("farmer_id") or 0)
            is_susp = int(r.get("is_suspended") or 0) == 1
            until_raw = r.get("suspended_until")
            active_susp = False
            if is_susp:
                if until_raw is None:
                    active_susp = True
                else:
                    try:
                        until_dt = (
                            until_raw
                            if isinstance(until_raw, datetime)
                            else datetime.strptime(str(until_raw)[:19], "%Y-%m-%d %H:%M:%S")
                        )
                        active_susp = until_dt > datetime.now()
                    except (TypeError, ValueError):
                        active_susp = True
            suspended_until_ms = None
            if until_raw and active_susp:
                try:
                    until_dt = (
                        until_raw
                        if isinstance(until_raw, datetime)
                        else datetime.strptime(str(until_raw)[:19], "%Y-%m-%d %H:%M:%S")
                    )
                    suspended_until_ms = int(until_dt.timestamp() * 1000)
                except (TypeError, ValueError):
                    suspended_until_ms = None

            out.append(
                {
                    "NO.": fid,
                    "farmer_id": fid,
                    "user_id": int(r.get("user_id") or 0) or None,
                    "is_blocked": active_susp,
                    "suspended_until": suspended_until_ms,
                    "suspension_reason": str(r.get("suspension_reason") or ""),
                    "warning_count": int(r.get("warning_count") or 0),
                    "last_warning_reason": str(r.get("last_warning_reason") or ""),
                    "LAST NAME": last,
                    "FIRST NAME": first,
                    "NAME OF FARMER": display,
                    "PHONE": phone_raw,
                    "phone": phone_raw,
                    "phone_number": phone_raw,
                    "ADDRESS (BARANGAY)": (r.get("barangay") or "") or "",
                    "FA OFFICER / MEMBER": (r.get("federation_assoc") or "") or "",
                    "BIRTHDAY": _fmt_birthday(r.get("birthday")),
                    "RSBSA Registered (Yes/No)": _rsbsa_label_from_db(r.get("rsbsa_registered")),
                    "RSBSA Registered Number": str(r.get("rsbsa_number") or ""),
                    "RSBSA Status": _rsbsa_status_label(r.get("rsbsa_status")),
                    "STATUS OF OWNERSHIP": own_raw,
                    **own_flags,
                    "TOTAL AREA PLANTED (HA.)": float(r.get("farm_size_ha") or 0)
                    if r.get("farm_size_ha") is not None
                    else 0,
                    "Total Area Planted (HA.)": float(r.get("farm_size_ha") or 0)
                    if r.get("farm_size_ha") is not None
                    else 0,
                    "LIBERICA BEARING": lb,
                    "LIBERICA NON-BEARING": ln,
                    "EXCELSA BEARING": eb,
                    "EXCELSA NON-BEARING": en,
                    "ROBUSTA BEARING": rb,
                    "ROBUSTA NON-BEARING": rn,
                    "TOTAL BEARING": lb + eb + rb,
                    "TOTAL NON-BEARING": ln + en + rn,
                    "TOTAL TREES": lb + eb + rb + ln + en + rn,
                    "LIBERICA PRODUCTION": float(r.get("liberica_qty_kg") or 0)
                    if r.get("liberica_qty_kg") is not None
                    else 0,
                    "EXCELSA PRODUCTION": float(r.get("excelsa_qty_kg") or 0)
                    if r.get("excelsa_qty_kg") is not None
                    else 0,
                    "ROBUSTA PRODUCTION": float(r.get("robusta_qty_kg") or 0)
                    if r.get("robusta_qty_kg") is not None
                    else 0,
                    "NCFRS": _ncfrs_label(r.get("ncfrs")),
                    "REMARKS": "",
                }
            )

        return jsonify(out)

    @app.route("/api/farmer-account-action", methods=["POST"])
    def api_farmer_account_action():
        """Record admin warning, suspend (3 days default), or unsuspend on a farmer account."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        params = _app_db_params()
        if not params:
            return jsonify({"error": "APP_DB_NOT_CONFIGURED"}), 503

        data = request.get_json(silent=True) or {}
        ok_fid, fid_err, farmer_id = validate_positive_int(
            data.get("farmer_id"), field="farmer_id", minimum=1
        )
        action = validate_enum(data.get("action"), FARMER_ACCOUNT_ACTIONS, "")
        try:
            reason = clean_text(data.get("reason"), REASON_MAX, "Reason", allow_empty=False) or ""
        except ValueError as exc:
            return api_error(str(exc), 400)
        ok_days, days_err, days = validate_positive_int(
            data.get("days") or 3, field="days", minimum=1, maximum=365
        )

        if not ok_fid:
            return api_error(fid_err, 400)
        if action not in FARMER_ACCOUNT_ACTIONS:
            return api_error("action must be warning, suspend, or unsuspend.", 400)
        if not ok_days:
            return api_error(days_err, 400)

        conn = None
        try:
            conn = connect_app_mysql(params)
            with conn.cursor() as cur:
                cur.execute("SELECT farmer_id FROM farmers WHERE farmer_id = %s LIMIT 1", (farmer_id,))
                if not cur.fetchone():
                    return jsonify({"error": "Farmer not found."}), 404

            if action == "warning":
                status = apply_warning(conn, farmer_id, reason)
            elif action == "suspend":
                status = apply_suspend(conn, farmer_id, reason, days=days)
            else:
                status = apply_unsuspend(conn, farmer_id, reason)

            try:
                conn.commit()
            except Exception:
                pass

            try:
                log_activity(
                    get_current_user_phone() or "admin",
                    f"FARMER_{action.upper()}",
                    f"Farmer #{farmer_id}: {reason[:120]}",
                    request.remote_addr,
                )
            except Exception:
                pass

            return jsonify(
                {
                    "ok": True,
                    "action": action,
                    "farmer_id": farmer_id,
                    "account_status": status,
                }
            )
        except Exception as e:
            return jsonify({"error": "APP_DB_UNREACHABLE", "detail": safe_error_message(e)}), 503
        finally:
            if conn:
                conn.close()

    @app.route("/api/farmer-picker", methods=["GET"])
    def api_farmer_picker():
        """Minimal farmer list for admin selects (coffee transactions, etc.)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        if _app_db_params():
            try:
                rows = _app_fetch_farmer_rows(limit=2500)
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            items = []
            for r in rows:
                fid = int(r.get("farmer_id") or 0)
                nm = (r.get("username") or "").strip()
                if not nm:
                    fn = (r.get("first_name") or "").strip()
                    ln = (r.get("last_name") or "").strip()
                    nm = (fn + " " + ln).strip()
                if not nm:
                    nm = (r.get("phone_number") or "").strip()
                items.append({"id": fid, "no": fid, "name": nm})
            return jsonify({"items": items})

        return jsonify({"error": "APP_DB_REQUIRED", "detail": "Configure XAMPP connection to load farmer picker."}), 503

    @app.route("/api/farmer-coffee-transactions", methods=["GET", "POST"])
    def api_farmer_coffee_transactions():
        """List or create farmer coffee bean transactions."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        if request.method == "GET":
            from api.transactions_api import load_admin_transactions

            try:
                items, source = load_admin_transactions(
                    request.args.get("limit", type=int) or 400,
                    request.args.get("farmer_id", type=int),
                )
                return jsonify({"ok": True, "items": items, "count": len(items), "source": source})
            except Exception as e:
                return jsonify(
                    {
                        "ok": False,
                        "error": "TRANSACTIONS_LOAD_FAILED",
                        "detail": str(e),
                        "items": [],
                    }
                )

        payload = request.get_json(silent=True) or {}
        ok_fid, fid_err, farmer_id_val = validate_positive_int(
            payload.get("farmer_id"), field="farmer_id", minimum=1
        )
        if not ok_fid:
            return api_error(fid_err, 400)

        farmer = db.session.get(Farmer, farmer_id_val)
        if not farmer:
            return jsonify({"error": "Farmer not found"}), 404

        variety = _normalize_coffee_variety(payload.get("variety"))
        if not variety:
            return api_error("variety must be liberica, excelsa, or robusta", 400)

        ok_delta, delta_err, delta_kg = validate_decimal_range(
            payload.get("delta_kg"),
            field="delta_kg",
            allow_zero=False,
            minimum=Decimal("-999999"),
            maximum=Decimal("999999"),
        )
        if not ok_delta or delta_kg is None:
            return api_error(delta_err or "delta_kg is required", 400)

        ok_pay, pay_err, payment_amount = validate_decimal_range(
            payload.get("payment_amount"),
            field="payment_amount",
            allow_zero=True,
            minimum=Decimal("0"),
            maximum=Decimal("99999999"),
        )
        if not ok_pay:
            return api_error(pay_err, 400)

        payment_method = validate_enum(
            (payload.get("payment_method") or "").strip().lower(),
            PAYMENT_METHODS,
            "",
        )
        try:
            reference_no = clean_text(payload.get("reference_no"), 64, "Reference number") or ""
            buyer_name = clean_text(payload.get("buyer_name"), 200, "Buyer name") or ""
            notes = clean_text(payload.get("notes"), 500, "Notes") or ""
        except ValueError as exc:
            return api_error(str(exc), 400)

        tx = FarmerCoffeeTransaction(
            farmer_id=farmer_id_val,
            recorded_at=datetime.utcnow(),
            variety=variety,
            delta_kg=delta_kg,
            payment_amount=payment_amount,
            payment_method=payment_method or None,
            reference_no=reference_no or None,
            buyer_name=buyer_name,
            notes=notes,
            recorded_by_phone=get_current_user_phone() or "",
        )
        db.session.add(tx)
        db.session.commit()

        log_activity(
            get_current_user_phone() or "",
            "COFFEE_BEAN_TX",
            f"Recorded {abs(delta_kg)} kg {variety}",
            request.remote_addr,
        )
        return jsonify({"success": True, "id": tx.id})
