"""
Messaging API routes for Beanthentic application.

Provides CRUD endpoints for the internal messaging system,
including compose, inbox, read, star, archive, and delete.
"""

from datetime import datetime

from flask import jsonify, request, session

from config.models import Message, db
from config.utils import get_current_user_phone, is_authenticated, load_users, log_activity


def register_messaging_routes(app):
    """Register messaging API routes with the Flask app."""

    @app.route("/api/messages", methods=["GET"])
    def api_messages_list():
        """List messages for the current user (inbox view)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        user_phone = get_current_user_phone() or ""
        folder = request.args.get("folder", "inbox")  # inbox | sent | starred | archived
        search = (request.args.get("search", "") or "").strip().lower()
        category = request.args.get("category", "").strip().lower()
        limit = min(int(request.args.get("limit", "100")), 500)

        query = Message.query

        if folder == "inbox":
            query = query.filter(
                (Message.recipient_phone == user_phone) | (Message.recipient_phone == ""),
                Message.is_archived == False,
            )
        elif folder == "sent":
            query = query.filter(Message.sender_phone == user_phone)
        elif folder == "starred":
            query = query.filter(
                ((Message.recipient_phone == user_phone) | (Message.recipient_phone == "") | (Message.sender_phone == user_phone)),
                Message.is_starred == True,
            )
        elif folder == "archived":
            query = query.filter(
                ((Message.recipient_phone == user_phone) | (Message.recipient_phone == "")),
                Message.is_archived == True,
            )
        else:
            query = query.filter(
                (Message.recipient_phone == user_phone) | (Message.recipient_phone == ""),
                Message.is_archived == False,
            )

        if category:
            query = query.filter(Message.category == category)

        query = query.order_by(Message.created_at.desc())
        messages = query.limit(limit).all()

        # Apply search in Python for flexibility
        items = [m.to_dict() for m in messages]
        if search:
            items = [
                m for m in items
                if search in (m.get("subject") or "").lower()
                or search in (m.get("body") or "").lower()
                or search in (m.get("sender_name") or "").lower()
                or search in (m.get("recipient_name") or "").lower()
            ]

        # Unread count for badge
        unread_count = Message.query.filter(
            (Message.recipient_phone == user_phone) | (Message.recipient_phone == ""),
            Message.is_read == False,
            Message.is_archived == False,
        ).count()

        return jsonify({"items": items, "unread_count": unread_count})

    @app.route("/api/messages", methods=["POST"])
    def api_messages_create():
        """Compose and send a new message."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        user_phone = get_current_user_phone() or ""
        users = load_users()
        sender = users.get(user_phone, {})
        sender_name = sender.get("full_name") or session.get("user_name") or user_phone

        data = request.get_json(silent=True) or {}
        subject = (data.get("subject") or "").strip()
        body = (data.get("body") or "").strip()
        category = (data.get("category") or "general").strip().lower()
        recipient_phone = (data.get("recipient_phone") or "").strip()
        farmer_id = data.get("farmer_id")

        if not subject:
            return jsonify({"error": "Subject is required."}), 400
        if not body:
            return jsonify({"error": "Message body is required."}), 400
        if category not in ("general", "farmer-update", "announcement", "reminder"):
            category = "general"

        # Resolve recipient name
        recipient_name = ""
        if recipient_phone:
            recipient = users.get(recipient_phone, {})
            recipient_name = recipient.get("full_name", "")

        msg = Message(
            sender_phone=user_phone,
            sender_name=sender_name,
            recipient_phone=recipient_phone,
            recipient_name=recipient_name,
            subject=subject,
            body=body,
            category=category,
            farmer_id=int(farmer_id) if farmer_id else None,
            is_read=False,
            is_starred=False,
            is_archived=False,
        )

        db.session.add(msg)
        db.session.commit()

        try:
            log_activity(user_phone, "MESSAGE_SENT", f"Sent message: {subject[:60]}", request.remote_addr)
        except Exception:
            db.session.rollback()

        return jsonify({"success": True, "message": msg.to_dict()}), 201

    @app.route("/api/messages/<int:message_id>", methods=["GET"])
    def api_messages_detail(message_id):
        """Get a single message and mark it as read."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        user_phone = get_current_user_phone() or ""
        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        # Mark as read if the current user is the recipient
        if not msg.is_read and (msg.recipient_phone == user_phone or msg.recipient_phone == ""):
            msg.is_read = True
            msg.read_at = datetime.utcnow()
            db.session.commit()

        return jsonify({"message": msg.to_dict()})

    @app.route("/api/messages/<int:message_id>/star", methods=["POST"])
    def api_messages_star(message_id):
        """Toggle star on a message."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        msg.is_starred = not msg.is_starred
        db.session.commit()

        return jsonify({"success": True, "is_starred": msg.is_starred})

    @app.route("/api/messages/<int:message_id>/archive", methods=["POST"])
    def api_messages_archive(message_id):
        """Toggle archive on a message."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        msg.is_archived = not msg.is_archived
        db.session.commit()

        return jsonify({"success": True, "is_archived": msg.is_archived})

    @app.route("/api/messages/<int:message_id>/read", methods=["POST"])
    def api_messages_mark_read(message_id):
        """Mark a message as read."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        msg.is_read = True
        msg.read_at = datetime.utcnow()
        db.session.commit()

        return jsonify({"success": True})

    @app.route("/api/messages/mark-all-read", methods=["POST"])
    def api_messages_mark_all_read():
        """Mark all inbox messages as read for the current user."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        user_phone = get_current_user_phone() or ""
        now = datetime.utcnow()

        updated = Message.query.filter(
            (Message.recipient_phone == user_phone) | (Message.recipient_phone == ""),
            Message.is_read == False,
        ).update({"is_read": True, "read_at": now}, synchronize_session="fetch")

        db.session.commit()

        return jsonify({"success": True, "updated": updated})

    @app.route("/api/messages/<int:message_id>", methods=["DELETE"])
    def api_messages_delete(message_id):
        """Delete a message permanently."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        user_phone = get_current_user_phone() or ""
        try:
            log_activity(user_phone, "MESSAGE_DELETED", f"Deleted message: {msg.subject[:60]}", request.remote_addr)
        except Exception:
            db.session.rollback()

        db.session.delete(msg)
        db.session.commit()

        return jsonify({"success": True})

    @app.route("/api/messages/unread-count", methods=["GET"])
    def api_messages_unread_count():
        """Get unread message count for badge display."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        user_phone = get_current_user_phone() or ""
        count = Message.query.filter(
            (Message.recipient_phone == user_phone) | (Message.recipient_phone == ""),
            Message.is_read == False,
            Message.is_archived == False,
        ).count()

        return jsonify({"unread_count": count})
