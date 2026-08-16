"""Admin calendar notes API — harvest / delivery / meeting reminders."""

from __future__ import annotations

from flask import jsonify, request

from config.calendar_notes_store import delete_note, list_notes, upsert_note
from config.security import require_admin, safe_error_message
from config.utils import get_current_user_phone, log_activity


def register_calendar_notes_routes(app):
    @app.route("/api/calendar-notes", methods=["GET"])
    @require_admin
    def api_calendar_notes_list():
        try:
            month = request.args.get("month")
            return jsonify(list_notes(month=month))
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc)}), 500

    @app.route("/api/calendar-notes/<date_key>", methods=["POST", "PUT"])
    @require_admin
    def api_calendar_notes_upsert(date_key: str):
        try:
            payload = request.get_json(silent=True) or {}
            if not payload.get("created_by"):
                payload["created_by"] = get_current_user_phone() or ""
            result = upsert_note(date_key, payload)
            if not result.get("ok"):
                return jsonify(result), 400
            phone = get_current_user_phone()
            log_activity(
                phone,
                "CALENDAR_NOTE_SAVED",
                f"Calendar note saved for {date_key}",
                request.remote_addr,
            )
            return jsonify(result)
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc)}), 500

    @app.route("/api/calendar-notes/<date_key>/<note_id>", methods=["DELETE"])
    @require_admin
    def api_calendar_notes_delete(date_key: str, note_id: str):
        try:
            result = delete_note(date_key, note_id)
            if not result.get("ok"):
                return jsonify(result), 404
            phone = get_current_user_phone()
            log_activity(
                phone,
                "CALENDAR_NOTE_DELETED",
                f"Calendar note deleted for {date_key}",
                request.remote_addr,
            )
            return jsonify(result)
        except Exception as exc:
            return jsonify({"ok": False, "error": safe_error_message(exc)}), 500
