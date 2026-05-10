"""
Misconduct report API endpoints for Beanthentic application.

Stores and lists customer reports about farmer misconduct for the Client Report module.
"""

from datetime import datetime

from flask import jsonify, request

from config.models import Farmer, MisconductReport, db
from config.utils import get_current_user_phone, is_authenticated, log_activity


ALLOWED_STATUSES = {"under review", "blocked", "resolved", "dismissed"}


def _clean_text(value, limit=None):
    if value is None:
        return ""
    text = str(value).strip()
    if limit:
        return text[:limit]
    return text


def register_misconduct_report_routes(app):
    @app.route("/api/misconduct-reports", methods=["GET", "POST"])
    def api_misconduct_reports():
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        if request.method == "GET":
            limit = request.args.get("limit", type=int) or 500
            limit = min(max(limit, 1), 1000)
            q = _clean_text(request.args.get("q"), 200).lower()
            status = _clean_text(request.args.get("status"), 40).lower()
            farmer_id = request.args.get("farmer_id", type=int)

            query = MisconductReport.query
            if status:
                if status not in ALLOWED_STATUSES:
                    return jsonify({"error": "Invalid status"}), 400
                query = query.filter(MisconductReport.status == status)
            if farmer_id:
                query = query.filter(MisconductReport.farmer_id == farmer_id)
            if q:
                like = f"%{q}%"
                query = query.filter(
                    db.or_(
                        db.func.lower(MisconductReport.reporter_name).like(like),
                        db.func.lower(MisconductReport.reporter_contact).like(like),
                        db.func.lower(MisconductReport.farmer_name).like(like),
                        db.func.lower(MisconductReport.allegation).like(like),
                    )
                )

            rows = (
                query.order_by(MisconductReport.created_at.desc(), MisconductReport.id.desc())
                .limit(limit)
                .all()
            )
            return jsonify({"items": [r.to_dict() for r in rows]})

        payload = request.get_json(silent=True) or {}

        reporter_name = _clean_text(payload.get("reporter_name"), 255)
        if not reporter_name:
            return jsonify({"error": "reporter_name is required"}), 400

        reporter_contact = _clean_text(payload.get("reporter_contact"), 255)
        allegation = _clean_text(payload.get("allegation"))
        if not allegation:
            return jsonify({"error": "allegation is required"}), 400

        status = _clean_text(payload.get("status"), 30).lower() or "open"
        if status not in ALLOWED_STATUSES:
            return jsonify({"error": "Invalid status"}), 400

        farmer_id_val = payload.get("farmer_id")
        farmer = None
        if farmer_id_val not in (None, "", 0, "0"):
            try:
                farmer_id_val = int(farmer_id_val)
            except (TypeError, ValueError):
                return jsonify({"error": "farmer_id must be an integer"}), 400
            farmer = db.session.get(Farmer, farmer_id_val)
            if not farmer:
                return jsonify({"error": "Farmer not found"}), 404

        report = MisconductReport(
            created_at=datetime.utcnow(),
            reporter_name=reporter_name,
            reporter_contact=reporter_contact,
            farmer_id=farmer.id if farmer else None,
            farmer_no=farmer.no if farmer else None,
            farmer_name=farmer.name if farmer else "",
            allegation=allegation,
            status=status,
        )
        db.session.add(report)
        db.session.commit()

        user_phone = get_current_user_phone() or ""
        details = f"Report #{report.id} by {reporter_name}"
        if farmer:
            details += f" against {farmer.name} (No. {farmer.no})"
        log_activity(user_phone, "MISCONDUCT_REPORT_CREATE", details, request.remote_addr)

        return jsonify({"success": True, "id": report.id, "item": report.to_dict()})

    @app.route("/api/misconduct-reports/<int:report_id>", methods=["PATCH"])
    def api_misconduct_report_patch(report_id):
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        report = db.session.get(MisconductReport, report_id)
        if not report:
            return jsonify({"error": "Not found"}), 404

        payload = request.get_json(silent=True) or {}
        status = _clean_text(payload.get("status"), 30).lower()
        if status and status not in ALLOWED_STATUSES:
            return jsonify({"error": "Invalid status"}), 400

        updated = False
        if status and status != report.status:
            report.status = status
            updated = True

        if not updated:
            return jsonify({"success": True, "item": report.to_dict()})

        db.session.commit()
        user_phone = get_current_user_phone() or ""
        log_activity(
            user_phone,
            "MISCONDUCT_REPORT_UPDATE",
            f"Report #{report.id} status -> {report.status}",
            request.remote_addr,
        )
        return jsonify({"success": True, "item": report.to_dict()})

