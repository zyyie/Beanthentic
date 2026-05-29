"""
Misconduct report API — admin Client Report module.

Lists/updates client_misconduct_report on beanthentic_app (never legacy misconduct_report ORM).
"""

from flask import jsonify, request

from api.client_reports_api import load_admin_client_reports, update_report_status
from config.app_connection import load_error_payload
from config.utils import get_current_user_phone, is_authenticated, log_activity

ALLOWED_STATUSES = {"under review", "blocked", "resolved", "dismissed", "open", "under_review"}


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
            return jsonify({"ok": False, "error": "Unauthorized", "items": []}), 401

        if request.method == "GET":
            limit = request.args.get("limit", type=int) or 500
            limit = min(max(limit, 1), 1000)
            q = _clean_text(request.args.get("q"), 200)
            status = _clean_text(request.args.get("status"), 40)
            try:
                items, source = load_admin_client_reports(limit, status, q)
                return jsonify({"ok": True, "items": items, "count": len(items), "source": source})
            except Exception as e:
                payload = load_error_payload("CLIENT_REPORTS_LOAD_FAILED", str(e))
                return jsonify(payload), 503

        payload = request.get_json(silent=True) or {}
        reporter_name = _clean_text(payload.get("reporter_name"), 255)
        if not reporter_name:
            return jsonify({"error": "reporter_name is required"}), 400
        return jsonify(
            {
                "error": "POST not supported here — reports are submitted from Client Web into XAMPP MySQL."
            }
        ), 501

    @app.route("/api/misconduct-reports/<int:report_id>", methods=["PATCH"])
    def api_misconduct_report_patch(report_id):
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        payload = request.get_json(silent=True) or {}
        status = _clean_text(payload.get("status"), 30).lower()
        if not status:
            return jsonify({"error": "status is required"}), 400
        try:
            item = update_report_status(report_id, status)
            user_phone = get_current_user_phone() or ""
            log_activity(
                user_phone,
                "MISCONDUCT_REPORT_UPDATE",
                f"Report #{report_id} status -> {item.get('status')}",
                request.remote_addr,
            )
            return jsonify({"success": True, "item": item})
        except LookupError:
            return jsonify({"error": "Not found"}), 404
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception as e:
            return jsonify({"error": str(e)}), 500
