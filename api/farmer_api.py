"""
Farmer data API endpoints for Beanthentic application.

Provides endpoints for farmer data, picker lists, and coffee transactions.
"""

from datetime import datetime
from decimal import Decimal, InvalidOperation

from flask import jsonify, request

from config.models import (
    Farmer,
    FarmerCoffeeTransaction,
    db,
)
from config.utils import get_current_user_phone, is_authenticated, log_activity


def register_farmer_routes(app):
    """Register farmer-related API routes with the Flask app."""

    @app.route("/api/farmer-data", methods=["GET"])
    def api_farmer_data():
        """Provide farmer data for dashboard in the same format as the original JSON."""
        farmers = Farmer.query.order_by(Farmer.no.asc()).all()

        # Convert to the same format as the original JSON data
        farmer_data = []
        for farmer in farmers:
            farmer_record = {
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
                "REMARKS": farmer.remarks or ""
            }
            farmer_data.append(farmer_record)

        return jsonify(farmer_data)

    @app.route("/api/farmer-picker", methods=["GET"])
    def api_farmer_picker():
        """Minimal farmer list for admin selects (coffee transactions, etc.)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        farmers = Farmer.query.order_by(Farmer.no.asc()).all()
        items = [
            {"id": f.id, "no": f.no, "name": f.name or ""}
            for f in farmers
        ]
        return jsonify({"items": items})

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
        """List or create farmer coffee bean kg ledger entries (admin Transactions module)."""
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

        buyer = (payload.get("buyer_name") or "").strip()[:200]
        notes = (payload.get("notes") or "").strip()
        user_phone = get_current_user_phone() or ""

        tx = FarmerCoffeeTransaction(
            farmer_id=farmer_id_val,
            recorded_at=datetime.utcnow(),
            variety=variety,
            delta_kg=delta_kg,
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
