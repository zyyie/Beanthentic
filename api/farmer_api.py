"""
Farmer data API endpoints for Beanthentic application.

Provides endpoints for farmer data, picker lists, and coffee transactions.
"""

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
import os
import re
from pathlib import Path
from http.client import RemoteDisconnected
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from flask import Response, jsonify, make_response, request
import pymysql
from pymysql.cursors import DictCursor

from config.app_connection import app_db_params as _shared_app_db_params
from config.app_connection import (
    app_http_timeout,
    app_server_base,
    friendly_load_failure,
    iter_app_server_bases,
    iter_legacy_asset_bases,
    prefer_app_http_bridge,
)
from config.farmer_moderation import (
    apply_suspend,
    apply_unsuspend,
    apply_warning,
    ensure_farmer_mod_columns,
    farmer_account_status,
)
from config.production_fields import (
    PRODUCTION_DETAIL_SELECT_SQL,
    ensure_production_detail_columns,
    expand_production_detail_into_row,
    gcb_qty_for_variety,
    production_detail_payload,
    production_row_extensions,
    roasted_qty_for_variety,
)
from config.models import Farmer, FarmerCoffeeTransaction, db
from config.mysql_app_bridge import connect_app_db
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
import beanthentic_env


def _app_db_params() -> dict | None:
    """Shared resolver (includes LAN fallbacks when settings use 127.0.0.1)."""
    return _shared_app_db_params()


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
    from config.app_connection import is_app_db_configured

    return is_app_db_configured()


def _load_dashboard_transactions(limit: int, farmer_id: int | None = None) -> tuple[list[dict], str, list[str]]:
    """
    Load approved/sent customer transactions (same as app Transaction History).
    Uses shared loader: MySQL first, HTTP app server fallback.
    """
    from api.transactions_api import load_admin_transactions

    try:
        items, source = load_admin_transactions(limit, farmer_id)
        return items, source, []
    except Exception as e:
        return [], "", [str(e)]


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
    timeout = min(app_http_timeout(), 8.0)
    for base in iter_app_server_bases():
        url = base + "/api/farmer-ownership-supplement.php"
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else None
            if isinstance(data, dict) and data.get("ok") is True:
                return data
        except (HTTPError, URLError, TimeoutError, ValueError):
            continue
    return None


def _fetch_farmer_data_via_app_server() -> tuple[list[dict] | None, str | None]:
    if not iter_app_server_bases():
        return None, "APP_SERVER_BASE_NOT_SET"
    last_err: str | None = None
    for base in iter_app_server_bases():
        url = base + "/api/admin_farmer_data.php"
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=app_http_timeout()) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else None
            if not isinstance(data, dict) or data.get("ok") is not True:
                last_err = "BAD_RESPONSE_FROM_APP_SERVER"
                continue
            items = data.get("items")
            return (items if isinstance(items, list) else []), None
        except (HTTPError, URLError, TimeoutError, ValueError) as e:
            last_err = str(e)
            continue
    return None, last_err or "APP_SERVER_UNREACHABLE"


def _fetch_customer_transactions_via_app_server(
    limit: int, farmer_id: int | None = None
) -> tuple[list[dict] | None, str | None]:
    """When admin PC cannot reach MySQL directly, use Beanthentic-App HTTP API on XAMPP device."""
    if not iter_app_server_bases():
        return None, "APP_SERVER_BASE_NOT_SET"
    limit = max(1, min(int(limit or 400), 800))
    last_err: str | None = None
    for base in iter_app_server_bases():
        url = f"{base}/api/admin_customer_transactions.php?limit={limit}"
        if farmer_id:
            url += f"&farmer_id={int(farmer_id)}"
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=app_http_timeout()) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else None
            if not isinstance(data, dict) or data.get("ok") is not True:
                err = (data or {}).get("error") if isinstance(data, dict) else None
                last_err = err or "BAD_RESPONSE_FROM_APP_SERVER"
                continue
            items = data.get("items")
            return (items if isinstance(items, list) else []), None
        except HTTPError as e:
            try:
                body = e.read().decode("utf-8", errors="replace")
                parsed = json.loads(body) if body else {}
                if isinstance(parsed, dict) and parsed.get("error"):
                    last_err = str(parsed.get("error"))
                    continue
            except Exception:
                pass
            last_err = f"HTTP {e.code}"
            continue
        except (URLError, TimeoutError, ValueError) as e:
            last_err = str(e)
            continue
    return None, last_err or "APP_SERVER_UNREACHABLE"


_FARM_INFO_COLUMNS: set[str] | None = None


def _is_postgresql_db(conn) -> bool:
    # Check if connection is PostgreSQL
    try:
        import os
        from pathlib import Path
        import json

        # First check env vars
        db_url = os.getenv("DATABASE_URL", "").strip()
        if db_url.startswith("postgresql://") or db_url.startswith("postgres://"):
            return True

        # Check settings.json
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        if settings_path.exists():
            try:
                settings = json.loads(settings_path.read_text(encoding="utf-8"))
                conn_settings = settings.get("connection", {})
                app_db_url = str(conn_settings.get("app_db_url", "")).strip()
                if app_db_url.startswith("postgresql://") or app_db_url.startswith("postgres://"):
                    return True
                dialect = str(conn_settings.get("app_db_dialect", "")).lower()
                if dialect in ("postgresql", "postgres"):
                    return True
            except Exception:
                pass
    except Exception:
        pass
    return False


def _farm_information_columns(conn) -> set[str]:
    global _FARM_INFO_COLUMNS
    if _FARM_INFO_COLUMNS is not None:
        return _FARM_INFO_COLUMNS
    try:
        with conn.cursor() as cur:
            if _is_postgresql_db(conn):
                cur.execute(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = CURRENT_SCHEMA()
                      AND table_name = 'farm_information'
                    """
                )
            else:
                cur.execute(
                    """
                    SELECT COLUMN_NAME
                    FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = 'farm_information'
                    """
                )
            rows = cur.fetchall() or []
            _FARM_INFO_COLUMNS = {
                str(row.get("COLUMN_NAME") or row[0]).strip()
                for row in rows
                if (row.get("COLUMN_NAME") if isinstance(row, dict) else row[0])
            }
    except Exception:
        _FARM_INFO_COLUMNS = {"ownership_status", "farm_size_ha", "barangay"}
    return _FARM_INFO_COLUMNS


def _farm_info_flag_select(conn) -> str:
    cols = _farm_information_columns(conn)
    parts = []
    for col in (
        "is_landowner",
        "is_cloa_holder",
        "is_leaseholder",
        "is_seasonal_farm_worker",
        "is_others",
    ):
        if col in cols:
            parts.append(f"fi.{col}")
    return (", " + ", ".join(parts)) if parts else ""


def _ensure_ownership_varchar(conn) -> None:
    """Allow wizard values in farm_information.ownership_status (ENUM drops landowner, etc.)."""
    try:
        with conn.cursor() as cur:
            if _is_postgresql_db(conn):
                cur.execute(
                    """
                    SELECT data_type FROM information_schema.columns
                    WHERE table_schema = CURRENT_SCHEMA()
                      AND table_name = 'farm_information'
                      AND column_name = 'ownership_status'
                    LIMIT 1
                    """
                )
                row = cur.fetchone() or {}
                col_type = str(row.get("data_type") or "").lower()
                if col_type in ("user-defined", "enum"):
                    cur.execute(
                        "ALTER TABLE farm_information ALTER COLUMN ownership_status TYPE VARCHAR(40)"
                    )
            else:
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
    # First try using beanthentic_env directly for PostgreSQL/Supabase
    if beanthentic_env.is_postgresql():
        return connect_app_db({})
    
    params = _app_db_params()
    if not params:
        return None
    return connect_app_db(params)


def _farmer_account_action_via_http(
    farmer_id: int,
    action: str,
    reason: str,
    days: int,
) -> dict:
    payload = {
        "farmer_id": farmer_id,
        "action": action,
        "reason": reason,
        "days": days,
    }
    last_err: Exception | None = None
    for base in _moderation_http_bases():
        url = base.rstrip("/") + "/api/farmer_account_action.php"
        try:
            req = Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Accept": "application/json", "Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(req, timeout=app_http_timeout()) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else {}
            if not isinstance(data, dict):
                last_err = RuntimeError(f"Bad response from {base}")
                continue
            if not data.get("ok"):
                last_err = RuntimeError(
                    str(data.get("detail") or data.get("error") or "App server rejected moderation action")
                )
                continue
            status = data.get("account_status")
            if isinstance(status, dict):
                return status
            return {}
        except HTTPError as exc:
            try:
                raw = exc.read().decode("utf-8", errors="replace")
                parsed = json.loads(raw) if raw else {}
                if isinstance(parsed, dict) and (parsed.get("error") or parsed.get("detail")):
                    last_err = RuntimeError(str(parsed.get("detail") or parsed.get("error")))
                    continue
            except Exception:
                pass
            last_err = RuntimeError(f"App server HTTP {exc.code} at {base}")
        except (URLError, TimeoutError, ValueError, OSError) as exc:
            last_err = exc
    if last_err:
        raise last_err
    raise RuntimeError("No app server reachable for warning/suspend (port 8080).")


def _read_settings_root() -> dict:
    try:
        settings_path = Path(__file__).resolve().parents[1] / "settings.json"
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _moderation_http_bases() -> list[str]:
    """
    App-server URLs for warning/suspend only.
    Tries sms_gateway.local_base_url first (often the XAMPP/phone device), then settings connection.
    """
    ordered: list[str] = []
    seen: set[str] = set()

    def add(url: str | None) -> None:
        base = (url or "").strip().rstrip("/")
        if base and base not in seen:
            seen.add(base)
            ordered.append(base)

    root = _read_settings_root()
    sms = root.get("sms") if isinstance(root.get("sms"), dict) else {}
    gw = sms.get("sms_gateway") if isinstance(sms.get("sms_gateway"), dict) else {}
    add(str(gw.get("local_base_url") or ""))
    add(str(sms.get("public_base_url") or "").replace(":5000", ":8080"))
    for base in iter_app_server_bases():
        add(base)
    return ordered


def _moderation_mysql_hosts() -> list[str]:
    """MySQL hosts to try for warning/suspend (configured IP + LAN fallbacks from settings)."""
    params = _app_db_params()
    if not params:
        return []
    from config.app_connection import lan_fallback_hosts

    hosts: list[str] = []
    seen: set[str] = set()
    primary = str(params.get("host") or "").strip()
    if primary:
        seen.add(primary)
        hosts.append(primary)
    for host in lan_fallback_hosts():
        if host not in seen:
            seen.add(host)
            hosts.append(host)
    root = _read_settings_root()
    gw = ((root.get("sms") or {}).get("sms_gateway") or {}) if isinstance(root.get("sms"), dict) else {}
    local = str(gw.get("local_base_url") or "")
    if "://" in local:
        from urllib.parse import urlparse

        h = (urlparse(local).hostname or "").strip()
        if h and h not in seen:
            seen.add(h)
            hosts.append(h)
    return hosts


def _connect_moderation_mysql():
    """Connection for warning/suspend — tries every candidate host before giving up."""
    if beanthentic_env.is_postgresql():
        return connect_app_db({})
    
    params = _app_db_params()
    if not params:
        return None
    last_err: Exception | None = None
    for host in _moderation_mysql_hosts():
        try:
            return connect_app_db({**params, "host": host})
        except Exception as e:
            last_err = e
    if last_err:
        raise last_err
    return None


def _run_farmer_account_action(
    farmer_id: int,
    action: str,
    reason: str,
    days: int,
) -> tuple[dict | None, Exception | None, Exception | None]:
    """
    Warning / suspend / unsuspend for cross-device admin.
    PostgreSQL/Supabase first, then HTTP (port 8080), then MySQL.
    Returns (status, http_error, mysql_error).
    """
    http_err: Exception | None = None
    mysql_err: Exception | None = None
    status: dict | None = None

    # Try PostgreSQL/Supabase first
    if beanthentic_env.is_postgresql():
        conn = None
        try:
            conn = _connect_moderation_mysql()
            ensure_farmer_mod_columns(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT farmer_id FROM farmers WHERE farmer_id = %s LIMIT 1",
                    (farmer_id,),
                )
                if not cur.fetchone():
                    raise LookupError("Farmer not found.")

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
            return status, None, None
        except LookupError:
            raise
        except Exception as e:
            mysql_err = e
            if conn:
                try:
                    conn.rollback()
                except Exception:
                    pass
        finally:
            if conn:
                conn.close()

    # Then try HTTP if no PostgreSQL
    if _moderation_http_bases():
        try:
            status = _farmer_account_action_via_http(farmer_id, action, reason, days)
            if status is not None:
                return status, None, None
        except Exception as e:
            http_err = e

    # Then try MySQL
    if _app_db_params():
        conn = None
        try:
            conn = _connect_moderation_mysql()
            ensure_farmer_mod_columns(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT farmer_id FROM farmers WHERE farmer_id = %s LIMIT 1",
                    (farmer_id,),
                )
                if not cur.fetchone():
                    raise LookupError("Farmer not found.")

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
            return status, http_err, None
        except LookupError:
            raise
        except Exception as e:
            mysql_err = e
        finally:
            if conn:
                conn.close()

    return status, http_err, mysql_err


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
    inner_sql = """
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
    sql = f"SELECT * FROM ({inner_sql.strip()}) AS txn WHERE 1=1"
    params: list = []
    if farmer_id:
        sql += " AND txn.farmer_id = %s"
        params.append(int(farmer_id))
    sql += """
        ORDER BY COALESCE(txn.approved_at, txn.transaction_date) DESC, txn.customer_transaction_id DESC
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


def _map_app_row_to_dashboard(
    r: dict,
    *,
    sqlite_by_name: dict | None = None,
    sqlite_by_phone: dict | None = None,
    sqlite_by_email: dict | None = None,
) -> dict:
    """Map Beanthentic-App DB row keys to dashboard table column labels."""
    from config.farmer_registration_complete import farmer_display_name

    row = expand_production_detail_into_row(dict(r))
    first = (row.get("first_name") or row.get("FIRST NAME") or "").strip()
    last = (row.get("last_name") or row.get("LAST NAME") or "").strip()
    fid = int(row.get("farmer_id") or 0)
    display = farmer_display_name(row, farmer_id=fid)
    phone_raw = (row.get("phone_number") or row.get("contact_number") or "").strip()

    rb = int(row.get("robusta_bearing") or 0)
    rn = int(row.get("robusta_non_bearing") or 0)
    lb = int(row.get("liberica_bearing") or 0)
    ln = int(row.get("liberica_non_bearing") or 0)
    eb = int(row.get("excelsa_bearing") or 0)
    en = int(row.get("excelsa_non_bearing") or 0)
    total_bearing = lb + eb + rb
    total_non_bearing = ln + en + rn
    total_trees = total_bearing + total_non_bearing

    own_raw = resolve_ownership_status(
        row.get("ownership_status") or row.get("STATUS OF OWNERSHIP"),
        first_name=first,
        last_name=last,
        phone=phone_raw,
        email=(row.get("user_email") or row.get("email") or ""),
        sqlite_by_name=sqlite_by_name or {},
        sqlite_by_phone=sqlite_by_phone or {},
        sqlite_by_email=sqlite_by_email or {},
        row_flags=row,
    )
    own_flags = ownership_columns(own_raw)

    rsbsa_reg = _rsbsa_label_from_db(row.get("rsbsa_registered"))
    rsbsa_status = _rsbsa_status_label(row.get("rsbsa_status"))
    if not rsbsa_status:
        if rsbsa_reg == "Yes":
            rsbsa_status = "Registered"
        elif rsbsa_reg == "Pending":
            rsbsa_status = "Pending RSBSA"
        else:
            rsbsa_status = "Not Yet Applied"

    federation = str(row.get("federation_assoc") or "").strip() or "—"
    rsbsa_number = str(row.get("rsbsa_number") or "").strip() or "—"
    ncfrs = _ncfrs_label(row.get("ncfrs"))
    coffee_varieties = _normalize_coffee_varieties(
        row.get("coffee_varieties")
        or row.get("coffee_variety")
        or row.get("varieties_produced")
        or row.get("coffee_varieties_produced")
    )
    coffee_distribution = _normalize_distribution_choice(
        row.get("coffee_distribution")
        or row.get("distribution_option")
        or row.get("distribution_method")
        or row.get("delivery_method")
    )

    is_susp = int(row.get("is_suspended") or 0) == 1
    until_raw = row.get("suspended_until")
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

    farm_ha = float(row.get("farm_size_ha") or 0) if row.get("farm_size_ha") is not None else 0
    lib_prod = gcb_qty_for_variety(row, "liberica")
    exc_prod = gcb_qty_for_variety(row, "excelsa")
    rob_prod = gcb_qty_for_variety(row, "robusta")
    prod_ext = production_row_extensions(row)

    row_out = _json_safe_row_values(row)
    photo_ref = _json_safe_photo_ref(row.get("profile_photo_data") or row.get("profile_photo"))
    municipality = str(row.get("municipality") or row.get("MUNICIPALITY") or "Lipa City").strip() or "Lipa City"
    province = str(row.get("province") or row.get("PROVINCE") or "Batangas").strip() or "Batangas"
    house_no = str(row.get("house_no") or row.get("HOUSE NO.") or "").strip()
    street = str(row.get("street") or row.get("STREET") or "").strip()

    mapped = {
        **row_out,
        "NO.": fid,
        "farmer_id": fid,
        "user_id": int(row.get("user_id") or 0) or None,
        "is_blocked": active_susp,
        "self_sale_enabled": bool(row.get("self_sale_enabled")),
        "consolidation_preference": str(row.get("consolidation_preference") or "").strip() or None,
        "pricelist_status": str(row.get("pricelist_status") or "").strip().lower() or None,
        "suspended_until": suspended_until_ms,
        "suspension_reason": str(row.get("suspension_reason") or ""),
        "warning_count": int(row.get("warning_count") or 0),
        "last_warning_reason": str(row.get("last_warning_reason") or ""),
        "first_name": first,
        "last_name": last,
        "LAST NAME": last,
        "FIRST NAME": first,
        "NAME OF FARMER": display,
        "PHONE": phone_raw,
        "phone": phone_raw,
        "phone_number": phone_raw,
        "CONTACT NUMBER": phone_raw,
        "registered_at": _json_safe_value(row.get("registered_at")),
        "created_at": _json_safe_value(row.get("registered_at") or row.get("created_at")),
        "ADDRESS (BARANGAY)": (row.get("barangay") or "").strip() or "—",
        "barangay": (row.get("barangay") or "").strip(),
        "HOUSE NO.": house_no,
        "house_no": house_no,
        "STREET": street,
        "street": street,
        "MUNICIPALITY": municipality,
        "municipality": municipality,
        "PROVINCE": province,
        "province": province,
        "BIRTHDAY": _fmt_birthday(row.get("birthday")),
        "birthday": _fmt_birthday(row.get("birthday")),
        "FA OFFICER / MEMBER": federation,
        "FA OFFICER/MEMBER": federation,
        "federation_assoc": federation if federation != "—" else "",
        "RSBSA Registered (Yes/No)": rsbsa_reg,
        "RSBSA REGISTERED (YES/NO)": rsbsa_reg.upper() if rsbsa_reg != "Pending" else "PENDING",
        "RSBSA NUMBER": rsbsa_number,
        "RSBSA Registered Number": rsbsa_number if rsbsa_number != "—" else "",
        "RSBSA Status": rsbsa_status,
        "RSBSA STATUS": rsbsa_status.upper(),
        "rsbsa_registered": row.get("rsbsa_registered"),
        "rsbsa_number": row.get("rsbsa_number") or "",
        "rsbsa_status": row.get("rsbsa_status") or "",
        "NCFRS": ncfrs,
        "ncfrs": row.get("ncfrs"),
        "STATUS OF OWNERSHIP": own_raw,
        **own_flags,
        "TOTAL AREA PLANTED (HA.)": farm_ha,
        "Total Area Planted (HA.)": farm_ha,
        "farm_size_ha": row.get("farm_size_ha"),
        "LIBERICA BEARING": lb,
        "LIBERICA NON-BEARING": ln,
        "EXCELSA BEARING": eb,
        "EXCELSA NON-BEARING": en,
        "ROBUSTA BEARING": rb,
        "ROBUSTA NON-BEARING": rn,
        "TOTAL BEARING": total_bearing,
        "TOTAL NON-BEARING": total_non_bearing,
        "TOTAL TREES": total_trees,
        "total_bearing_trees": total_bearing,
        "LIBERICA PRODUCTION": lib_prod,
        "EXCELSA PRODUCTION": exc_prod,
        "ROBUSTA PRODUCTION": rob_prod,
        "LIBERICA (KG)": lib_prod,
        "EXCELSA (KG)": exc_prod,
        "ROBUSTA (KG)": rob_prod,
        "LIBERICA ROASTED QTY": roasted_qty_for_variety(row, "liberica"),
        "EXCELSA ROASTED QTY": roasted_qty_for_variety(row, "excelsa"),
        "ROBUSTA ROASTED QTY": roasted_qty_for_variety(row, "robusta"),
        "LIBERICA HARVEST UNIT": str(row.get("liberica_harvest_unit") or "").strip(),
        "EXCELSA HARVEST UNIT": str(row.get("excelsa_harvest_unit") or "").strip(),
        "ROBUSTA HARVEST UNIT": str(row.get("robusta_harvest_unit") or "").strip(),
        "LIBERICA GCB UNIT": str(row.get("liberica_gcb_unit") or "kg").strip(),
        "EXCELSA GCB UNIT": str(row.get("excelsa_gcb_unit") or "kg").strip(),
        "ROBUSTA GCB UNIT": str(row.get("robusta_gcb_unit") or "kg").strip(),
        "LIBERICA ROASTED UNIT": str(row.get("liberica_roasted_unit") or "kg").strip(),
        "EXCELSA ROASTED UNIT": str(row.get("excelsa_roasted_unit") or "kg").strip(),
        "ROBUSTA ROASTED UNIT": str(row.get("robusta_roasted_unit") or "kg").strip(),
        "COFFEE VARIETIES": coffee_varieties,
        "coffee_varieties": coffee_varieties,
        "COFFEE DISTRIBUTION": coffee_distribution,
        "coffee_distribution": coffee_distribution,
        "production_detail": production_detail_payload(row),
        **prod_ext,
        "STATUS": row.get("status") or "",
        "status": row.get("status") or "",
        "profile_photo": photo_ref,
        "profile_photo_data": photo_ref,
        "profile_photo_url": row.get("profile_photo_url") or "",
        "photo_url": row.get("photo_url") or row.get("profile_photo_url") or "",
        "REMARKS": "",
    }
    return _json_safe_row_values(mapped)


_PHOTOS_MANIFEST_CACHE: dict[str, object] = {"at": 0.0, "data": {}}


def _http_body_is_php_source(body: bytes) -> bool:
    head = body[:64].lstrip()
    return head.startswith(b"<?php") or head.startswith(b"<?")


def _fetch_farmer_photos_manifest_via_http() -> dict[int, str]:
    """Load farmer_id -> data URL from app server (admin_bridges.py or PHP manifest)."""
    import time

    now = time.time()
    cached_at = float(_PHOTOS_MANIFEST_CACHE.get("at") or 0)
    cached = _PHOTOS_MANIFEST_CACHE.get("data")
    if isinstance(cached, dict) and now - cached_at < 300:
        return cached

    manifest: dict[int, str] = {}
    photo_bases = list(iter_app_server_bases()) or list(iter_legacy_asset_bases())
    if not photo_bases:
        _PHOTOS_MANIFEST_CACHE["at"] = now
        _PHOTOS_MANIFEST_CACHE["data"] = manifest
        return manifest

    timeout = min(app_http_timeout(), 20.0)
    for base in photo_bases:
        url = f"{base}/api/admin_farmer_photos.php"
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            if _http_body_is_php_source(raw):
                continue
            data = json.loads(raw.decode("utf-8", errors="replace")) if raw else None
            if not isinstance(data, dict) or data.get("ok") is not True:
                continue
            items = data.get("items")
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                fid = int(item.get("farmer_id") or 0)
                photo = str(
                    item.get("photo")
                    or item.get("data_url")
                    or item.get("profile_photo_data")
                    or ""
                ).strip()
                if fid > 0 and photo:
                    manifest[fid] = photo
            if manifest:
                break
        except (
            HTTPError,
            URLError,
            TimeoutError,
            ValueError,
            json.JSONDecodeError,
            RemoteDisconnected,
            ConnectionResetError,
            OSError,
        ):
            continue

    _PHOTOS_MANIFEST_CACHE["at"] = now
    _PHOTOS_MANIFEST_CACHE["data"] = manifest
    return manifest


def _attach_farmer_photo_fields(rows: list) -> list[dict]:
    """Embed photo data URLs or API paths on each farmer row."""
    from config.app_connection import iter_app_server_bases, iter_legacy_asset_bases
    from config.farmer_profile_photo import (
        farmer_profile_photo_api_path,
        normalize_profile_photo_url,
        resolve_farmer_profile_photo_display_url,
    )

    manifest: dict[int, str] = {}
    if iter_app_server_bases() or iter_legacy_asset_bases():
        try:
            manifest = _fetch_farmer_photos_manifest_via_http()
        except Exception:
            manifest = {}
    out: list[dict] = []
    for item in rows:
        if not item:
            continue
        # Convert psycopg2 DictRow to dict if needed
        row = dict(item)
        fid = int(row.get("farmer_id") or row.get("NO.") or 0)
        if fid > 0:
            raw_photo = (
                manifest.get(fid)
                or row.get("profile_photo_data")
                or row.get("profile_photo")
                or row.get("PHOTO")
                or row.get("profile_photo_url")
            )
            inline = normalize_profile_photo_url(raw_photo)
            if inline:
                row["profile_photo_url"] = inline
                row["photo_url"] = inline
                row["PHOTO"] = inline
            else:
                url = resolve_farmer_profile_photo_display_url(
                    raw_photo,
                    fid,
                    api_path_fn=farmer_profile_photo_api_path,
                )
                row["profile_photo_url"] = url
                row["photo_url"] = url
                row["PHOTO"] = url
            if raw_photo:
                row["profile_photo"] = str(raw_photo).strip()
        out.append(row)
    return out


def _farmer_profile_photo_via_http(farmer_id: int) -> tuple[bytes, str] | None:
    photo_bases = list(iter_app_server_bases()) or list(iter_legacy_asset_bases())
    if not photo_bases:
        return None
    fid = int(farmer_id or 0)
    if fid < 1:
        return None

    try:
        manifest = _fetch_farmer_photos_manifest_via_http()
    except Exception:
        manifest = {}
    inline = manifest.get(fid)
    if inline and inline.startswith("data:image/"):
        from config.farmer_profile_photo import _parse_data_url

        parsed = _parse_data_url(inline)
        if parsed:
            return parsed

    timeout = min(app_http_timeout(), 6.0)
    for base in photo_bases:
        url = f"{base}/api/admin_farmer_profile_photo.php?farmer_id={fid}"
        try:
            req = Request(url, headers={"Accept": "image/*,*/*"})
            with urlopen(req, timeout=timeout) as resp:
                ctype = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
                body = resp.read()
                if _http_body_is_php_source(body):
                    continue
                if body and ctype.startswith("image/"):
                    return body, ctype
        except HTTPError as e:
            if e.code == 404:
                continue
        except (URLError, TimeoutError, ValueError, RemoteDisconnected, ConnectionResetError, OSError):
            continue
    return None


def _fetch_profile_photo_from_url(url: str) -> tuple[bytes, str] | None:
    from config.farmer_profile_photo import _parse_data_url

    text = str(url or "").strip()
    if not text:
        return None
    parsed = _parse_data_url(text)
    if parsed:
        return parsed
    if not re.match(r"^https?://", text, re.I):
        return None
    timeout = min(app_http_timeout(), 6.0)
    try:
        req = Request(text, headers={"Accept": "image/*,*/*"})
        with urlopen(req, timeout=timeout) as resp:
            ctype = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
            body = resp.read()
            if body and ctype.startswith("image/"):
                return body, ctype
    except (HTTPError, URLError, TimeoutError, ValueError, RemoteDisconnected, ConnectionResetError, OSError):
        return None
    return None


def _json_safe_photo_ref(value) -> str:
    """String path/URL for JSON responses — never raw bytes."""
    if value is None:
        return ""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return ""
    return str(value).strip()


def _json_safe_value(value):
    """Convert a single DB value for jsonify."""
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ", timespec="seconds") if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, Decimal):
        try:
            return float(value)
        except (InvalidOperation, ValueError):
            return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return ""
    return value


def _json_safe_row_values(row: dict) -> dict:
    """Convert DB types (date, Decimal, bytes) for jsonify."""
    out: dict = {}
    for key, value in row.items():
        if key == "profile_photo_data":
            text = _json_safe_photo_ref(value)
            if text.startswith("data:image/") or (
                text.startswith("https://") and "supabase.co/storage/" in text
            ):
                out[key] = text
            continue
        out[key] = _json_safe_value(value)
    return out


def _mime_from_photo_path(path: str) -> str:
    ext = os.path.splitext(str(path or ""))[1].lower()
    return {
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }.get(ext, "image/jpeg")


def _serve_farmer_profile_photo_path(raw_path: str, farmer_id: int) -> tuple[bytes, str] | None:
    from config.app_connection import iter_legacy_asset_bases
    from config.farmer_profile_photo import resolve_farmer_upload_path, supabase_public_photo_url

    text = str(raw_path or "").strip()
    if not text:
        return None

    fid = int(farmer_id or 0)

    local_path = resolve_farmer_upload_path(text)
    if local_path and local_path.is_file():
        try:
            data = local_path.read_bytes()
            if data and len(data) > 32:
                return data, _mime_from_photo_path(str(local_path))
        except OSError:
            pass

    import beanthentic_env
    from config.farmer_profile_photo import (
        profile_photo_storage_candidates,
        fetch_photo_bytes_from_app_server,
        backfill_farmer_photo_to_storage,
    )

    for name in profile_photo_storage_candidates(text, fid):
        stored = beanthentic_env.download_from_supabase_storage(name)
        if stored:
            return stored

    fetched = fetch_photo_bytes_from_app_server(text)
    if fetched:
        backfill_farmer_photo_to_storage(fid, fetched[0], fetched[1])
        return fetched

    if re.match(r"^https?://", text, re.I):
        served = _fetch_profile_photo_from_url(text)
        if served:
            return served

    public = supabase_public_photo_url(text, fid)
    if public:
        served = _fetch_profile_photo_from_url(public)
        if served:
            return served

    http = _farmer_profile_photo_via_http(fid)
    if http:
        return http

    rel = text if text.startswith("/") else f"/{text}"
    for base in iter_legacy_asset_bases():
        served = _fetch_profile_photo_from_url(f"{base.rstrip('/')}{rel}")
        if served:
            return served
        served = _fetch_profile_photo_from_url(
            f"{base.rstrip('/')}/api/admin_farmer_profile_photo.php?farmer_id={fid}"
        )
        if served:
            return served

    return None


def _try_supabase_storage_photo(profile_photo: str | None, farmer_id: int) -> tuple[bytes, str] | None:
    """Download farmer photo from Supabase Storage or public URL — no PostgreSQL."""
    import beanthentic_env
    from config.farmer_profile_photo import profile_photo_storage_candidates, supabase_public_photo_url

    for name in profile_photo_storage_candidates(profile_photo, farmer_id):
        stored = beanthentic_env.download_from_supabase_storage(name)
        if stored:
            return stored
        public = supabase_public_photo_url(name, farmer_id)
        if public:
            served = _fetch_profile_photo_from_url(public)
            if served:
                return served
    return None


def _serve_farmer_profile_photo_from_db(farmer_id: int) -> tuple[bytes, str] | None:
    from config.farmer_profile_photo import (
        fetch_farmer_photo_record,
        fetch_farmer_photo_record_rest,
        photo_record_to_bytes,
    )

    fid = int(farmer_id or 0)
    if fid < 1:
        return None

    import beanthentic_env

    if beanthentic_env.uses_supabase_anon():
        try:
            rec = fetch_farmer_photo_record_rest(fid)
            if rec:
                served = photo_record_to_bytes(rec, fid)
                if served:
                    return served
                if rec.get("kind") in ("path", "url"):
                    served = _serve_farmer_profile_photo_path(str(rec.get("value") or ""), fid)
                    if served:
                        return served
                raw_ref = str(rec.get("value") or "")
                served = _try_supabase_storage_photo(raw_ref, fid)
                if served:
                    return served
        except Exception:
            pass
        return _try_supabase_storage_photo(None, fid)

    conn = _app_db_connect()
    if not conn:
        return None
    try:
        rec = fetch_farmer_photo_record(conn, fid)
        if not rec:
            return None
        if rec.get("kind") == "blob":
            return bytes(rec["value"]), str(rec.get("mime") or "image/jpeg")
        if rec.get("kind") == "url":
            return _fetch_profile_photo_from_url(str(rec.get("value") or ""))
        if rec.get("kind") == "path":
            return _serve_farmer_profile_photo_path(str(rec.get("value") or ""), fid)
    except Exception:
        return None
    finally:
        conn.close()
    return None


def _serve_farmer_profile_photo_bytes(farmer_id: int) -> tuple[bytes, str] | None:
    fid = int(farmer_id or 0)
    if fid < 1:
        return None

    import beanthentic_env

    if beanthentic_env.uses_supabase_anon() or beanthentic_env.is_postgresql():
        served = _serve_farmer_profile_photo_from_db(fid)
        if served:
            return served
        if beanthentic_env.uses_supabase_anon():
            http = _farmer_profile_photo_via_http(fid)
            if http:
                return http
            return None

    http = _farmer_profile_photo_via_http(fid)
    if http:
        return http

    return _serve_farmer_profile_photo_from_db(fid)


def _detect_schema_mode(conn):
    """Detect if using legacy_supabase (id as farmer PK) or app (farmer_id)."""
    try:
        with conn.cursor() as cur:
            if _is_postgresql_db(conn):
                cur.execute("""
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = CURRENT_SCHEMA() AND table_name = 'farmers' AND column_name = 'farmer_id'
                """)
            else:
                cur.execute("""
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = DATABASE() AND table_name = 'farmers' AND column_name = 'farmer_id'
                """)
            has_farmer_id = len(cur.fetchall()) > 0
            return 'app' if has_farmer_id else 'legacy_supabase'
    except:
        return 'legacy_supabase'

def _get_farmer_pk(conn):
    mode = _detect_schema_mode(conn)
    return 'farmer_id' if mode == 'app' else 'id'


def _db_column_exists(conn, table: str, column: str) -> bool:
    """Check if a table column exists in current schema/database."""
    if not table or not column:
        return False
    try:
        with conn.cursor() as cur:
            if _is_postgresql_db(conn):
                cur.execute(
                    """
                    SELECT 1
                      FROM information_schema.columns
                     WHERE table_schema = CURRENT_SCHEMA()
                       AND table_name = %s
                       AND column_name = %s
                     LIMIT 1
                    """,
                    (table, column),
                )
            else:
                cur.execute(
                    """
                    SELECT 1
                      FROM information_schema.columns
                     WHERE table_schema = DATABASE()
                       AND table_name = %s
                       AND column_name = %s
                     LIMIT 1
                    """,
                    (table, column),
                )
            return bool(cur.fetchone())
    except Exception:
        return False


def _optional_select_expr(
    conn,
    *,
    table_name: str,
    table_alias: str,
    alias: str,
    candidates: tuple[str, ...],
) -> str:
    """Build SELECT expression for first existing optional column."""
    for col in candidates:
        if _db_column_exists(conn, table_name, col):
            return f"{table_alias}.{col} AS {alias}"
    return f"NULL AS {alias}"


def _normalize_coffee_varieties(raw_value) -> str:
    """Normalize DB value into display string (Liberica, Robusta, ...)."""
    label_map = {
        "liberica": "Liberica",
        "robusta": "Robusta",
        "excelsa": "Excelsa",
        "kapeng barako": "Liberica",
    }

    def _label(val) -> str:
        token = str(val or "").strip()
        if not token:
            return ""
        key = token.lower()
        return label_map.get(key, token.replace("_", " ").title())

    parsed = raw_value
    if isinstance(raw_value, str):
        text = raw_value.strip()
        if not text:
            return ""
        if text.startswith("[") or text.startswith("{"):
            try:
                parsed = json.loads(text)
            except Exception:
                parsed = text
        else:
            parsed = [p.strip() for p in re.split(r"[;,|/]", text) if p.strip()]

    items: list[str] = []
    if isinstance(parsed, dict):
        for key, val in parsed.items():
            if isinstance(val, bool) and not val:
                continue
            if val in (None, "", 0, "0", "false", "False"):
                continue
            lbl = _label(key)
            if lbl:
                items.append(lbl)
    elif isinstance(parsed, (list, tuple, set)):
        for val in parsed:
            lbl = _label(val)
            if lbl:
                items.append(lbl)
    else:
        lbl = _label(parsed)
        if lbl:
            items.append(lbl)

    uniq: list[str] = []
    seen: set[str] = set()
    for item in items:
        low = item.lower()
        if low in seen:
            continue
        seen.add(low)
        uniq.append(item)
    return ", ".join(uniq)


def _normalize_distribution_choice(raw_value) -> str:
    token = str(raw_value or "").strip()
    if not token:
        return ""
    normalized = token.replace("_", " ").replace("-", " ").strip()
    return re.sub(r"\s+", " ", normalized).title()

def _app_fetch_farmer_rows(limit: int = 2000) -> list[dict]:
    """
    Fetch farmer dataset from XAMPP MySQL/Supabase PostgreSQL schema used by Beanthentic-App.
    Returns dict rows ready to map to dashboard keys.
    """
    import beanthentic_env

    if beanthentic_env.uses_supabase_anon():
        from config.supabase_farmer_load import fetch_farmer_rows_via_rest

        return fetch_farmer_rows_via_rest(limit=limit)

    conn = _app_db_connect()
    if not conn:
        return []
    limit = max(1, min(int(limit or 2000), 5000))
    flag_select = _farm_info_flag_select(conn)
    farmer_pk = _get_farmer_pk(conn)
    from config.farmer_profile_photo import farmer_photo_select_sql

    photo_select = farmer_photo_select_sql(conn) or ", f.profile_photo AS profile_photo_data"
    optional_selects = [
        _optional_select_expr(
            conn,
            table_name="farm_information",
            table_alias="fi",
            alias="coffee_varieties",
            candidates=(
                "coffee_varieties",
                "coffee_variety",
                "varieties_produced",
                "coffee_varieties_produced",
            ),
        ),
        _optional_select_expr(
            conn,
            table_name="farm_information",
            table_alias="fi",
            alias="coffee_distribution",
            candidates=(
                "coffee_distribution",
                "distribution_option",
                "distribution_method",
                "delivery_method",
            ),
        ),
        _optional_select_expr(
            conn,
            table_name="farm_information",
            table_alias="fi",
            alias="latitude",
            candidates=("latitude", "lat", "gps_lat", "gps_latitude", "farm_lat", "farm_latitude"),
        ),
        _optional_select_expr(
            conn,
            table_name="farm_information",
            table_alias="fi",
            alias="longitude",
            candidates=("longitude", "lng", "lon", "gps_lng", "gps_longitude", "farm_lng", "farm_longitude"),
        ),
        _optional_select_expr(
            conn,
            table_name="production_information",
            table_alias="prod",
            alias="consolidation_preference",
            candidates=("consolidation_preference",),
        ),
        _optional_select_expr(
            conn,
            table_name="production_information",
            table_alias="prod",
            alias="pricelist_status",
            candidates=("pricelist_status",),
        ),
    ]
    for variety in ("liberica", "excelsa", "robusta"):
        optional_selects.extend(
            [
                _optional_select_expr(
                    conn,
                    table_name="production_information",
                    table_alias="prod",
                    alias=f"{variety}_harvest_unit",
                    candidates=(f"{variety}_harvest_unit", f"{variety}_harvest_qty_unit", f"{variety}_harvest_uom"),
                ),
                _optional_select_expr(
                    conn,
                    table_name="production_information",
                    table_alias="prod",
                    alias=f"{variety}_gcb_unit",
                    candidates=(f"{variety}_gcb_unit", f"{variety}_gcb_qty_unit", f"{variety}_gcb_uom"),
                ),
                _optional_select_expr(
                    conn,
                    table_name="production_information",
                    table_alias="prod",
                    alias=f"{variety}_roasted_unit",
                    candidates=(f"{variety}_roasted_unit", f"{variety}_roasted_qty_unit", f"{variety}_roasted_uom"),
                ),
            ]
        )
    optional_select_sql = ",\n        ".join(optional_selects)
    sql = f"""
      SELECT
        f.{farmer_pk} AS farmer_id,
        u.user_id,
        u.username,
        u.phone_number,
        u.created_at AS registered_at,
        u.email AS user_email,
        f.status,
        pi.first_name,
        pi.last_name,
        pi.contact_number,
        pi.birthday,
        COALESCE(pi.barangay, fi.barangay) AS barangay,
        fi.ownership_status{flag_select},
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
        {optional_select_sql},
        {PRODUCTION_DETAIL_SELECT_SQL},
        f.is_suspended,
        f.suspended_until,
        f.suspension_reason,
        f.warning_count,
        f.last_warning_at,
        f.last_warning_reason,
        COALESCE(f.self_sale_enabled, FALSE) AS self_sale_enabled{photo_select}
      FROM farmers f
      LEFT JOIN users u ON u.user_id = f.user_id
      LEFT JOIN personal_information pi ON pi.farmer_id = f.{farmer_pk}
      LEFT JOIN farm_information fi ON fi.farmer_id = f.{farmer_pk}
      LEFT JOIN affiliation_information ai ON ai.farmer_id = f.{farmer_pk}
      LEFT JOIN tree_counts tc
        ON tc.farmer_id = f.{farmer_pk}
       AND tc.record_year = (
          SELECT MAX(t2.record_year) FROM tree_counts t2 WHERE t2.farmer_id = f.{farmer_pk}
        )
      LEFT JOIN production_information prod
        ON prod.farmer_id = f.{farmer_pk}
       AND prod.production_year = (
          SELECT MAX(p2.production_year) FROM production_information p2 WHERE p2.farmer_id = f.{farmer_pk}
        )
      ORDER BY f.{farmer_pk} ASC
      LIMIT %s
    """
    try:
        _ensure_ownership_varchar(conn)
        ensure_farmer_mod_columns(conn)
        ensure_production_detail_columns(conn)
        try:
            from config.pricing_store import ensure_pricing_schema

            ensure_pricing_schema(conn)
        except Exception:
            pass
        with conn.cursor() as cur:
            cur.execute(sql, (limit,))
            rows = cur.fetchall() or []
            out = []
            for row in rows:
                if not isinstance(row, dict):
                    out.append(row)
                    continue
                r = dict(row)
                lat = r.get("latitude")
                lng = r.get("longitude")
                try:
                    lat_f = float(lat) if lat is not None and lat != "" else None
                except (TypeError, ValueError):
                    lat_f = None
                try:
                    lng_f = float(lng) if lng is not None and lng != "" else None
                except (TypeError, ValueError):
                    lng_f = None
                if lat_f is not None:
                    r["latitude"] = lat_f
                    r["lat"] = lat_f
                    r["gps_lat"] = lat_f
                    r["farm_lat"] = lat_f
                if lng_f is not None:
                    r["longitude"] = lng_f
                    r["lng"] = lng_f
                    r["gps_lng"] = lng_f
                    r["farm_lng"] = lng_f
                out.append(r)
            return out
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

        from api.gi_contributions_api import probe_app_mysql, probe_gi_app_server

        mysql_ok, mysql_err = probe_app_mysql(timeout=4.0)
        http_ok, http_base, http_err = probe_gi_app_server(timeout=4.0)
        out = {
            "ok": False,
            "configured": True,
            "host": params["host"],
            "port": params["port"],
            "database": params["database"],
            "user": params["user"],
            "app_server_base": app_server_base() or None,
            "mysql_reachable": mysql_ok,
            "mysql_error": None if mysql_ok else mysql_err,
            "http_reachable": http_ok,
            "http_base": http_base or None,
            "http_error": None if http_ok else http_err,
            "prefer_http_bridge": prefer_app_http_bridge(),
            "hint": (
                "When http_reachable is true, farmer data, messages, transactions, and reports "
                "sync over port 8080. MySQL on port 3306 is optional on the admin PC."
            ),
        }
        if http_ok or mysql_ok:
            out["ok"] = True

        if http_ok:
            try:
                items, _err = _fetch_farmer_data_via_app_server()
                out["farmers_count_http"] = len(items) if items else 0
            except Exception:
                out["farmers_count_http"] = None

        conn = None
        if not mysql_ok:
            return jsonify(out), 200
        try:
            from config.mysql_app_bridge import connect_app_db

            conn = connect_app_db(params)
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
            return jsonify(out), 200
        except Exception as e:
            if not out.get("http_reachable"):
                out["error"] = safe_error_message(e, public="Could not connect to app database.")
            return jsonify(out), 200
        finally:
            if conn:
                conn.close()

    @app.route("/api/farmer-data", methods=["GET"])
    def api_farmer_data():
        """Provide farmer data for dashboard from XAMPP beanthentic_app or Supabase."""
        from config.farmer_registration_complete import (
            farmer_display_name,
            filter_completed_registration_rows,
        )
        import beanthentic_env

        if not is_authenticated():
            return jsonify({"error": "Unauthorized", "message": "Admin login required."}), 401

        # If using Supabase/PostgreSQL, use that directly
        if beanthentic_env.is_postgresql():
            try:
                try:
                    # Keep production types (GCB/roasted/harvest) in sync with app-side
                    # production_bean_classifications on each dashboard refresh.
                    from config.mysql_app_bridge import connect_app_db
                    from config.supabase_production_sync import sync_production_bean_classifications

                    sync_conn = connect_app_db({})
                    try:
                        sync_production_bean_classifications(sync_conn)
                    finally:
                        sync_conn.close()
                except Exception:
                    pass
                rows_from_db = filter_completed_registration_rows(_app_fetch_farmer_rows(limit=2500))
                raw = [dict(r) for r in rows_from_db]
                with_photos = _attach_farmer_photo_fields(raw)
                mapped = [_map_app_row_to_dashboard(r) for r in with_photos]
                return jsonify(mapped)
            except Exception as e:
                return jsonify({"error": "SUPABASE_LOAD_FAILED", "detail": str(e)}), 503

        def _sync_registrations(rows: list[dict]) -> None:
            try:
                from config.farmer_registration_cursor import sync_new_farmer_registrations

                sync_new_farmer_registrations(rows)
            except Exception:
                pass

        def _http_farmer_rows() -> list[dict]:
            items, err = _fetch_farmer_data_via_app_server()
            if items is None:
                raise RuntimeError(err or "APP_SERVER_UNREACHABLE")
            return filter_completed_registration_rows(items)

        app_db = _app_db_params()
        def _apply_ownership_to_rows(items: list[dict]) -> list[dict]:
            supplement = _fetch_ownership_supplement_via_app_server() or {}
            sqlite_by_name = supplement.get("by_name") if isinstance(supplement.get("by_name"), dict) else {}
            sqlite_by_phone = supplement.get("by_phone") if isinstance(supplement.get("by_phone"), dict) else {}
            sqlite_by_email = supplement.get("by_email") if isinstance(supplement.get("by_email"), dict) else {}
            out_rows: list[dict] = []
            for r in items:
                if not isinstance(r, dict):
                    continue
                row = dict(r)
                first = (row.get("first_name") or row.get("FIRST NAME") or "").strip()
                last = (row.get("last_name") or row.get("LAST NAME") or "").strip()
                own_raw = resolve_ownership_status(
                    row.get("ownership_status") or row.get("STATUS OF OWNERSHIP"),
                    first_name=first,
                    last_name=last,
                    phone=(row.get("phone_number") or row.get("PHONE") or ""),
                    email=(row.get("user_email") or row.get("email") or ""),
                    sqlite_by_name=sqlite_by_name,
                    sqlite_by_phone=sqlite_by_phone,
                    sqlite_by_email=sqlite_by_email,
                    row_flags=row,
                )
                if own_raw:
                    row["STATUS OF OWNERSHIP"] = own_raw
                    row.update(ownership_columns(own_raw))
                out_rows.append(row)
            return out_rows

        if prefer_app_http_bridge():
            try:
                rows = _attach_farmer_photo_fields(_apply_ownership_to_rows(_http_farmer_rows()))
                _sync_registrations(rows)
                return jsonify(rows)
            except Exception as http_exc:
                if not app_db:
                    load_msg = friendly_load_failure(
                        module_label="farmer data", http_error=http_exc
                    )
                    return jsonify({"error": "APP_LOAD_FAILED", "detail": load_msg}), 503

        if not app_db:
            items, err = _fetch_farmer_data_via_app_server()
            if items is not None:
                filtered = _attach_farmer_photo_fields(
                    _apply_ownership_to_rows(filter_completed_registration_rows(items))
                )
                _sync_registrations(filtered)
                return jsonify(filtered)
            return jsonify(
                {
                    "error": "APP_DB_NOT_CONFIGURED",
                    "detail": "Set Beanthentic/settings.json connection.app_db_host (and optionally app_server_base).",
                    "fallback_error": err,
                }
            ), 503

        try:
            raw_rows = filter_completed_registration_rows(_app_fetch_farmer_rows(limit=2500))
            supplement = _fetch_ownership_supplement_via_app_server() or {}
            sqlite_by_name = supplement.get("by_name") if isinstance(supplement.get("by_name"), dict) else {}
            sqlite_by_phone = supplement.get("by_phone") if isinstance(supplement.get("by_phone"), dict) else {}
            sqlite_by_email = supplement.get("by_email") if isinstance(supplement.get("by_email"), dict) else {}
            rows = _attach_farmer_photo_fields(
                [
                    _map_app_row_to_dashboard(
                        dict(r),
                        sqlite_by_name=sqlite_by_name,
                        sqlite_by_phone=sqlite_by_phone,
                        sqlite_by_email=sqlite_by_email,
                    )
                    for r in raw_rows
                ]
            )
            _sync_registrations(rows)
            return jsonify(rows)
        except Exception as e:
            items, err = _fetch_farmer_data_via_app_server()
            if items is not None:
                items = _attach_farmer_photo_fields(
                    _apply_ownership_to_rows(filter_completed_registration_rows(items))
                )
                _sync_registrations(items)
                if items and (items[0].get("FIRST NAME") or items[0].get("first_name")):
                    return jsonify(items)
                mapped = []
                for r in items:
                    fid = int(r.get("farmer_id") or 0)
                    first = (r.get("first_name") or r.get("FIRST NAME") or "").strip()
                    last = (r.get("last_name") or r.get("LAST NAME") or "").strip()
                    display = farmer_display_name(r, farmer_id=fid)
                    phone_raw = (r.get("phone_number") or r.get("contact_number") or "").strip()
                    trees = int(r.get("total_bearing_trees") or 0)
                    mapped.append(
                        {
                            "NO.": fid,
                            "farmer_id": fid,
                            "first_name": first,
                            "last_name": last,
                            "barangay": (r.get("barangay") or "").strip(),
                            "farm_size_ha": r.get("farm_size_ha"),
                            "total_bearing_trees": trees,
                            "FIRST NAME": first,
                            "LAST NAME": last,
                            "NAME OF FARMER": display,
                            "CONTACT NUMBER": phone_raw,
                            "PHONE": phone_raw,
                            "phone_number": phone_raw,
                            "ADDRESS (BARANGAY)": (r.get("barangay") or "").strip(),
                            "TOTAL AREA PLANTED (HA.)": float(r.get("farm_size_ha") or 0)
                            if r.get("farm_size_ha") is not None
                            else 0,
                            "TOTAL TREES": trees,
                            "STATUS": r.get("status") or "",
                            "status": r.get("status") or "",
                        }
                    )
                return jsonify(_attach_farmer_photo_fields(mapped))
            load_msg = friendly_load_failure(module_label="farmer data", mysql_error=e)
            if err:
                load_msg = f"{load_msg} App server fallback: {err}"
            return jsonify(
                {
                    "error": "APP_DB_UNREACHABLE",
                    "detail": load_msg,
                    "message": load_msg,
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
            fid = int(r.get("farmer_id") or 0)
            display = farmer_display_name(r, farmer_id=fid)

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
                row_flags=r,
            )
            own_flags = ownership_columns(own_raw)

            phone_raw = (r.get("phone_number") or r.get("contact_number") or "").strip()

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
                    **production_row_extensions(r),
                    "production_detail": production_detail_payload(r),
                    "NCFRS": _ncfrs_label(r.get("ncfrs")),
                    "REMARKS": "",
                }
            )

        return jsonify(_attach_farmer_photo_fields(out))

    @app.route("/api/farmer-production-detail", methods=["POST"])
    def api_farmer_production_detail():
        """Upsert GCB/roasted classification + qty for a farmer's latest production row."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized", "message": "Admin login required."}), 401

        data = request.get_json(silent=True) or {}
        ok_fid, fid_err, farmer_id = validate_positive_int(
            data.get("farmer_id"), field="farmer_id", minimum=1
        )
        if not ok_fid:
            return api_error(fid_err, 400)

        conn = _app_db_connect()
        if not conn:
            return api_error("App database not configured.", 503)

        try:
            from config.supabase_production_sync import upsert_production_detail

            saved = upsert_production_detail(conn, farmer_id, data)
            if not saved:
                return api_error("No production detail fields to save for this farmer.", 400)

            rows = _app_fetch_farmer_rows(limit=2500)
            row = next((r for r in rows if int(r.get("farmer_id") or 0) == farmer_id), None)
            if not row:
                return jsonify({"ok": True, "farmer_id": farmer_id, "message": "Saved."})

            mapped = _map_app_row_to_dashboard(dict(row))
            return jsonify({"ok": True, "farmer_id": farmer_id, "production": mapped})
        except Exception as exc:
            return api_error(safe_error_message(exc, public="Could not save production detail."), 500)
        finally:
            conn.close()

    @app.route("/api/app/production-detail", methods=["POST", "OPTIONS"])
    def api_app_production_detail():
        """Mobile app: sync GCB/roasted classifications + qty into production_information."""
        if request.method == "OPTIONS":
            return make_response("", 204)

        data = request.get_json(silent=True) or {}
        ok_fid, fid_err, farmer_id = validate_positive_int(
            data.get("farmer_id"), field="farmer_id", minimum=1
        )
        if not ok_fid:
            return jsonify({"ok": False, "error": fid_err}), 400

        conn = _app_db_connect()
        if not conn:
            return jsonify({"ok": False, "error": "APP_DB_NOT_CONFIGURED"}), 503

        try:
            from config.supabase_production_sync import upsert_production_detail

            saved = upsert_production_detail(conn, farmer_id, data)
            if not saved:
                return jsonify(
                    {
                        "ok": False,
                        "error": "NO_PRODUCTION_FIELDS",
                        "detail": "Include GCB/roasted qty or classification fields.",
                    }
                ), 400
            return jsonify({"ok": True, "farmer_id": farmer_id})
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc)}), 500
        finally:
            conn.close()

    @app.route("/api/farmer-profile-photo/<int:farmer_id>", methods=["GET"])
    def api_farmer_profile_photo(farmer_id: int):
        """Serve farmer profile image from Supabase REST/Storage (no PostgreSQL pooler)."""
        try:
            served = _serve_farmer_profile_photo_bytes(farmer_id)
        except Exception:
            served = None
        if not served:
            return jsonify({"error": "not_found"}), 404
        data, mime = served
        return Response(
            data,
            mimetype=mime,
            headers={"Cache-Control": "private, max-age=3600"},
        )

    @app.route("/api/farmer-account-action", methods=["POST"])
    def api_farmer_account_action():
        """Record admin warning, suspend (3 days default), or unsuspend on a farmer account."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized", "message": "Admin login required."}), 401

        try:
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

            try:
                status, http_err, mysql_err = _run_farmer_account_action(
                    farmer_id, action, reason, days
                )
            except LookupError:
                return jsonify(
                    {"error": "Farmer not found.", "message": "Farmer not found."}
                ), 404

            if status is None:
                if not beanthentic_env.is_postgresql() and not _app_db_params() and not _moderation_http_bases():
                    return jsonify(
                        {
                            "error": "APP_DB_NOT_CONFIGURED",
                            "detail": "Set app_db_host or app_server_base in settings.json.",
                            "message": "Set app_db_host or app_server_base in settings.json.",
                        }
                    ), 503
                detail = friendly_load_failure(
                    module_label="farmer account action",
                    mysql_error=mysql_err,
                    http_error=http_err,
                )
                return jsonify(
                    {
                        "error": "APP_DB_UNREACHABLE",
                        "detail": detail,
                        "message": detail,
                    }
                ), 503

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
            msg = friendly_load_failure(module_label="farmer account action", mysql_error=e)
            return jsonify(
                {
                    "error": "FARMER_ACCOUNT_ACTION_FAILED",
                    "detail": msg,
                    "message": msg,
                }
            ), 500

    @app.route("/api/farmer-picker", methods=["GET"])
    def api_farmer_picker():
        """Minimal farmer list for admin selects (coffee transactions, etc.)."""
        from config.farmer_registration_complete import (
            farmer_display_name,
            filter_completed_registration_rows,
        )

        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        if _app_db_params():
            try:
                rows = filter_completed_registration_rows(
                    _app_fetch_farmer_rows(limit=2500)
                )
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            items = []
            for r in rows:
                fid = int(r.get("farmer_id") or 0)
                nm = farmer_display_name(r, farmer_id=fid)
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
