"""
Farmer data API endpoints for Beanthentic application.

Provides endpoints for farmer data, picker lists, and coffee transactions.
"""

from datetime import datetime
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path

from flask import jsonify, request
import pymysql
from pymysql.cursors import DictCursor

from config.models import (
    Farmer,
    FarmerCoffeeTransaction,
    db,
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


def _app_db_connect():
    params = _app_db_params()
    if not params:
        return None
    return pymysql.connect(**params)


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
        u.email,
        f.status,
        pi.first_name,
        pi.last_name,
        COALESCE(pi.barangay, fi.barangay) AS barangay,
        fi.ownership_status,
        fi.farm_size_ha,
        ai.federation_assoc,
        ai.rsbsa_registered,
        ai.rsbsa_number,
        tc.robusta_bearing,
        tc.robusta_non_bearing,
        tc.liberica_bearing,
        tc.liberica_non_bearing,
        tc.excelsa_bearing,
        tc.excelsa_non_bearing,
        prod.robusta_qty_kg,
        prod.liberica_qty_kg,
        prod.excelsa_qty_kg
      FROM farmers f
      JOIN users u ON u.user_id = f.user_id
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
        with conn.cursor() as cur:
            cur.execute(sql, (limit,))
            rows = cur.fetchall() or []
            return list(rows)
    finally:
        conn.close()


def register_farmer_routes(app):
    """Register farmer-related API routes with the Flask app."""

    @app.route("/api/farmer-data", methods=["GET"])
    def api_farmer_data():
        """
        Provide farmer data for dashboard.
        
        MOBILE APP CONNECTION:
        - Method: GET
        - Endpoint: /api/farmer-data
        - Returns: List of all farmer records.
        """
        # If configured, source farmers from the app's XAMPP MySQL database.
        app_db = _app_db_params()
        if app_db:
            try:
                rows = _app_fetch_farmer_rows(limit=2500)
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503

            out = []
            for r in rows:
                first = (r.get("first_name") or "").strip()
                last = (r.get("last_name") or "").strip()
                display = (r.get("username") or "").strip()
                if not display:
                    display = (first + " " + last).strip()
                if not display:
                    display = (r.get("phone_number") or "").strip()

                rb = int(r.get("robusta_bearing") or 0)
                rn = int(r.get("robusta_non_bearing") or 0)
                lb = int(r.get("liberica_bearing") or 0)
                ln = int(r.get("liberica_non_bearing") or 0)
                eb = int(r.get("excelsa_bearing") or 0)
                en = int(r.get("excelsa_non_bearing") or 0)

                rec = {
                    # Map to the exact keys dashboard.js expects.
                    "NO.": int(r.get("farmer_id") or 0),
                    "NAME OF FARMER": display,
                    "ADDRESS (BARANGAY)": (r.get("barangay") or "") or "",
                    "FA OFFICER / MEMBER": (r.get("federation_assoc") or "") or "",
                    "BIRTHDAY": "",  # Not stored in beanthentic_app schema
                    "RSBSA Registered (Yes/No)": "Yes" if int(r.get("rsbsa_registered") or 0) == 1 else "No",
                    "STATUS OF OWNERSHIP": (r.get("ownership_status") or "") or "",
                    "Total Area Planted (HA.)": float(r.get("farm_size_ha") or 0) if r.get("farm_size_ha") is not None else 0,
                    "LIBERICA BEARING": lb,
                    "LIBERICA NON-BEARING": ln,
                    "EXCELSA BEARING": eb,
                    "EXCELSA NON-BEARING": en,
                    "ROBUSTA BEARING": rb,
                    "ROBUSTA NON-BEARING": rn,
                    "TOTAL BEARING": lb + eb + rb,
                    "TOTAL NON-BEARING": ln + en + rn,
                    "TOTAL TREES": lb + eb + rb + ln + en + rn,
                    "LIBERICA PRODUCTION": float(r.get("liberica_qty_kg") or 0) if r.get("liberica_qty_kg") is not None else 0,
                    "EXCELSA PRODUCTION": float(r.get("excelsa_qty_kg") or 0) if r.get("excelsa_qty_kg") is not None else 0,
                    "ROBUSTA PRODUCTION": float(r.get("robusta_qty_kg") or 0) if r.get("robusta_qty_kg") is not None else 0,
                    "NCFRS": "",
                    "REMARKS": "",
                }
                out.append(rec)

            return jsonify(out)

        # Default: use this website's own database.
        farmers = Farmer.query.order_by(Farmer.no.asc()).all()
        farmer_data = []
        for farmer in farmers:
            farmer_data.append(
                {
                    "NO.": farmer.no,
                    "NAME OF FARMER": farmer.name,
                    "ADDRESS (BARANGAY)": farmer.address_barangay,
                    "FA OFFICER / MEMBER": farmer.fa_officer_member,
                    "BIRTHDAY": farmer.birthday or "",
                    "RSBSA Registered (Yes/No)": farmer.rsbsa_registered,
                    "STATUS OF OWNERSHIP": farmer.status_ownership or "",
                    "Total Area Planted (HA.)": farmer.total_area_planted_ha,
                    "LIBERICA BEARING": farmer.liberica_bearing,
                    "LIBERICA NON-BEARING": farmer.liberica_non_bearing,
                    "EXCELSA BEARING": farmer.excelsa_bearing,
                    "EXCELSA NON-BEARING": farmer.excelsa_non_bearing,
                    "ROBUSTA BEARING": farmer.robusta_bearing,
                    "ROBUSTA NON-BEARING": farmer.robusta_non_bearing,
                    "TOTAL BEARING": farmer.total_bearing,
                    "TOTAL NON-BEARING": farmer.total_non_bearing,
                    "TOTAL TREES": farmer.total_trees,
                    "LIBERICA PRODUCTION": farmer.liberica_production,
                    "EXCELSA PRODUCTION": farmer.excelsa_production,
                    "ROBUSTA PRODUCTION": farmer.robusta_production,
                    "NCFRS": farmer.ncfrs or "",
                    "REMARKS": farmer.remarks or "",
                }
            )

        return jsonify(farmer_data)

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

        farmers = Farmer.query.order_by(Farmer.no.asc()).all()
        return jsonify({"items": [{"id": f.id, "no": f.no, "name": f.name or ""} for f in farmers]})

    def _normalize_coffee_variety(variety):
        """Normalize coffee variety names."""
        if not variety:
            return None
        v = str(variety).strip().lower()
        if v in ("liberica", "excelsa", "robusta"):
            return v
        return None

    def _coffee_balance_after_by_txn_id():
        """Calculate coffee balance after each transaction."""
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

    @app.route("/api/farmer-coffee-transactions", methods=["GET", "POST"])
    def api_farmer_coffee_transactions():
        """
        List or create farmer coffee bean transactions.
        
        MOBILE APP CONNECTION:
        - GET: Fetch history (filter by farmer_id)
        - POST: Record new transaction
        - Endpoint: /api/farmer-coffee-transactions
        - JSON Payload (POST): farmer_id, variety, delta_kg, payment_amount, payment_method, reference_no, buyer_name, notes
        """
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        if request.method == "GET":
            limit = request.args.get("limit", type=int) or 400
            limit = min(max(limit, 1), 800)
            farmer_id = request.args.get("farmer_id", type=int)

            balance_after = _coffee_balance_after_by_txn_id()

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
            return jsonify({"items": items})

        # POST — record movement (negative delta = sale / stock out)
        payload = request.get_json(silent=True) or {}
        farmer_id_val = payload.get("farmer_id")
        try:
            farmer_id_val = int(farmer_id_val)
        except (TypeError, ValueError):
            return jsonify({"error": "farmer_id is required"}), 400

        farmer = db.session.get(Farmer, farmer_id_val)
        if not farmer:
            return jsonify({"error": "Farmer not found"}), 404

        variety = _normalize_coffee_variety(payload.get("variety"))
        if not variety:
            return jsonify({"error": "variety must be liberica, excelsa, or robusta"}), 400

        try:
            delta_kg = Decimal(str(payload.get("delta_kg")))
        except (InvalidOperation, TypeError, ValueError):
            return jsonify({"error": "delta_kg must be a number"}), 400

        if delta_kg == 0:
            return jsonify({"error": "delta_kg cannot be zero"}), 400

        payment_amount = payload.get("payment_amount")
        if payment_amount:
            try:
                payment_amount = Decimal(str(payment_amount))
            except (InvalidOperation, TypeError, ValueError):
                payment_amount = None

        payment_method = payload.get("payment_method")
        reference_no = payload.get("reference_no")
        buyer = (payload.get("buyer_name") or "").strip()[:200]
        notes = (payload.get("notes") or "").strip()
        user_phone = get_current_user_phone() or ""

        tx = FarmerCoffeeTransaction(
            farmer_id=farmer_id_val,
            recorded_at=datetime.utcnow(),
            variety=variety,
            delta_kg=delta_kg,
            payment_amount=payment_amount,
            payment_method=payment_method,
            reference_no=reference_no,
            buyer_name=buyer,
            notes=notes,
            recorded_by_phone=user_phone,
        )
        db.session.add(tx)
        db.session.commit()

        # Log the transaction
        sign_word = "Sale / out" if delta_kg < 0 else "Addition"
        details = f"{sign_word}: {abs(delta_kg)} kg {variety} — {farmer.name} (No. {farmer.no})"
        if buyer:
            details += f" — buyer: {buyer}"
        log_activity(user_phone, "COFFEE_BEAN_TX", details, request.remote_addr)

        return jsonify({"success": True, "id": tx.id})
