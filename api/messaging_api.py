"""
Messaging API routes for Beanthentic application.

Provides CRUD endpoints for the internal messaging system,
including compose, inbox, read, star, archive, and delete.
"""

from datetime import datetime
import json
import os
from pathlib import Path
import re

from flask import jsonify, request, session
import pymysql
from pymysql.cursors import DictCursor

from config.app_connection import (
    app_db_params,
    app_server_base,
    friendly_load_failure,
    is_app_db_configured,
    load_error_payload,
)
from config.phone_utils import normalize_phone as _normalize_phone, phone_variants
from config.messaging_load import (
    MessagesLoadError,
    _ensure_shared_messages_table,
    connect_messaging_mysql,
    load_shared_messages,
    load_shared_messages_thread,
    load_unread_message_count,
    send_shared_message,
)
from config.models import Message, db
from config.mysql_app_bridge import connect_app_db
import beanthentic_env
from config.security import safe_error_message
from pymysql.err import OperationalError
from config.validation import (
    MESSAGE_BODY_MAX,
    MESSAGE_CATEGORIES,
    MESSAGE_SUBJECT_MAX,
    clean_text,
    validate_enum,
    validate_positive_int,
)
from config.utils import (
    get_current_farmer_phone,
    get_current_user_phone,
    is_authenticated,
    is_farmer_authenticated,
    load_users,
    log_activity,
)


def _shared_db_params() -> dict | None:
    """Backward-compatible alias for app_db_params()."""
    return app_db_params()


def _use_shared_messages() -> bool:
    """True when messages live in shared_messages (Supabase / app DB), not admin SQLAlchemy only."""
    return is_app_db_configured() or beanthentic_env.uses_supabase_anon()


def _shared_connect():
    if _use_shared_messages():
        return connect_messaging_mysql()
    params = app_db_params()
    if not params:
        return None
    return connect_messaging_mysql()


def _parse_message_fields(data: dict) -> tuple[dict | None, str | None]:
    """Validate compose payload; returns (fields, error_message)."""
    try:
        subject = clean_text(data.get("subject"), MESSAGE_SUBJECT_MAX, "Subject", allow_empty=False)
        body = clean_text(data.get("body"), MESSAGE_BODY_MAX, "Message body", allow_empty=False)
        recipient_name = clean_text(data.get("recipient_name"), 120, "Recipient name", allow_empty=True) or ""
    except ValueError as exc:
        return None, str(exc)
    category = validate_enum(data.get("category"), MESSAGE_CATEGORIES, "general")
    farmer_id = data.get("farmer_id")
    parsed_farmer_id = None
    if farmer_id is not None and farmer_id != "":
        ok_fid, fid_err, parsed_farmer_id = validate_positive_int(farmer_id, field="farmer_id", minimum=1)
        if not ok_fid:
            return None, fid_err
    return {
        "subject": subject,
        "body": body,
        "category": category,
        "recipient_name": recipient_name,
        "farmer_id": parsed_farmer_id,
        "recipient_phone_raw": (data.get("recipient_phone") or "").strip(),
    }, None


def _normalize_shared_message_row(row: dict) -> dict:
    """Lowercase roles and ISO-format datetimes for JSON clients."""
    if not row:
        return row
    m = dict(row)
    for key in ("sender_role", "recipient_role"):
        if m.get(key) is not None:
            m[key] = str(m[key]).lower()
    created = m.get("created_at")
    if created is not None and hasattr(created, "isoformat"):
        m["created_at"] = created.isoformat()
    read_at = m.get("read_at")
    if read_at is not None and hasattr(read_at, "isoformat"):
        m["read_at"] = read_at.isoformat()
    return m


def _shared_identity():
    """
    Returns (role, phone, name_hint).
    role: 'admin' if website admin session else 'farmer' for farmer portal session.
    """
    if is_authenticated():
        role = "admin"
        phone_raw = get_current_user_phone() or ""
        name_hint = (session.get("user_name") or "").strip()
    else:
        role = "farmer"
        phone_raw = get_current_farmer_phone() or ""
        name_hint = (session.get("farmer_name") or "").strip()
    return role, _normalize_phone(phone_raw), name_hint


def register_messaging_routes(app):
    """Register messaging API routes with the Flask app."""
    
    @app.route("/api/farmer-send-message", methods=["POST"])
    def api_farmer_send_message():
        """Allow farmers to send messages directly to admin via web.py."""
        if not is_farmer_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        try:
            data = request.get_json(silent=True) or request.form or {}
            # Force identity from farmer session — ignore spoofed body fields.
            sender_phone = get_current_farmer_phone() or ""
            sender_name = (session.get("farmer_name") or "").strip() or sender_phone
            subject = str(data.get("subject") or "Message from Farmer")
            body = str(data.get("body") or "")
            category = str(data.get("category") or "general")[:30]
            farmer_id = session.get("farmer_id")
            farmer_id = int(farmer_id) if farmer_id and str(farmer_id).isdigit() else None

            if not sender_phone:
                return jsonify({"error": "Unauthorized"}), 401

            saved = send_shared_message(
                role="farmer",
                phone=sender_phone,
                sender_name=sender_name,
                recipient_role="admin",
                recipient_phone="",
                recipient_name="Admin",
                subject=subject,
                body=body,
                category=category,
                farmer_id=farmer_id,
            )
            return jsonify({"success": True, "message": saved}), 201
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/api/messages", methods=["GET"])
    def api_messages_list():
        """List messages for the current user (inbox view)."""
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        # Shared DB (Supabase shared_messages) — same store as Beanthentic-App
        if _use_shared_messages():
            role, phone, _name = _shared_identity()
            folder = request.args.get("folder", "inbox")  # inbox | sent | starred | archived | all
            search = (request.args.get("search", "") or "").strip().lower()
            category = request.args.get("category", "").strip().lower()
            limit = min(int(request.args.get("limit", "100")), 500)

            try:
                items, unread_count, source = load_shared_messages(
                    folder=folder,
                    search=search,
                    category=category,
                    limit=limit,
                    role=role,
                    phone=phone,
                )
                return jsonify({"items": items, "unread_count": unread_count, "source": source, "ok": True})
            except MessagesLoadError as e:
                msg = friendly_load_failure(
                    module_label="messages",
                    mysql_error=e.mysql_error,
                    http_error=e.http_error,
                )
                return jsonify(load_error_payload("MESSAGES_LOAD_FAILED", msg)), 503
            except Exception as e:
                msg = friendly_load_failure(
                    module_label="messages",
                    mysql_error=e if isinstance(e, OperationalError) else None,
                    http_error=None if isinstance(e, OperationalError) else e,
                )
                return jsonify(load_error_payload("MESSAGES_LOAD_FAILED", msg)), 503

        user_phone = (get_current_user_phone() or get_current_farmer_phone() or "")
        normalized_user_phone = _normalize_phone(user_phone)
        folder = request.args.get("folder", "inbox")  # inbox | sent | starred | archived
        search = (request.args.get("search", "") or "").strip().lower()
        category = request.args.get("category", "").strip().lower()
        limit = min(int(request.args.get("limit", "100")), 500)

        query = Message.query

        if folder == "inbox":
            query = query.filter(
                (Message.recipient_phone == user_phone) | 
                (Message.recipient_phone == normalized_user_phone) | 
                (Message.recipient_phone == ""),
                Message.is_archived == False,
            )
        elif folder == "sent":
            query = query.filter(
                (Message.sender_phone == user_phone) | 
                (Message.sender_phone == normalized_user_phone)
            )
        elif folder == "starred":
            query = query.filter(
                (Message.recipient_phone == user_phone) | 
                (Message.recipient_phone == normalized_user_phone) | 
                (Message.recipient_phone == "") | 
                (Message.sender_phone == user_phone) |
                (Message.sender_phone == normalized_user_phone),
                Message.is_starred == True,
            )
        elif folder == "archived":
            query = query.filter(
                (Message.recipient_phone == user_phone) | 
                (Message.recipient_phone == normalized_user_phone) | 
                (Message.recipient_phone == ""),
                Message.is_archived == True,
            )
        elif folder == "all":
            # All conversations for the current user
            query = query.filter(
                (Message.recipient_phone == user_phone) | 
                (Message.recipient_phone == normalized_user_phone) | 
                (Message.recipient_phone == "") | 
                (Message.sender_phone == user_phone) |
                (Message.sender_phone == normalized_user_phone)
            )
        else:
            query = query.filter(
                (Message.recipient_phone == user_phone) | 
                (Message.recipient_phone == normalized_user_phone) | 
                (Message.recipient_phone == ""),
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

    @app.route("/api/messages/thread", methods=["GET"])
    def api_messages_thread():
        """All messages between the current user and a farmer phone (chat history)."""
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        farmer_phone = request.args.get("phone", "") or ""
        variants = phone_variants(farmer_phone)
        if not variants:
            return jsonify({"error": "phone is required."}), 400

        if _use_shared_messages():
            try:
                items = load_shared_messages_thread(farmer_phone)
                return jsonify({"items": items, "ok": True})
            except MessagesLoadError as e:
                msg = friendly_load_failure(
                    module_label="message thread",
                    mysql_error=e.mysql_error,
                    http_error=e.http_error,
                )
                return jsonify(load_error_payload("MESSAGES_THREAD_FAILED", msg)), 503
            except Exception as e:
                msg = friendly_load_failure(
                    module_label="message thread",
                    mysql_error=e if isinstance(e, OperationalError) else None,
                    http_error=None if isinstance(e, OperationalError) else e,
                )
                return jsonify(load_error_payload("MESSAGES_THREAD_FAILED", msg)), 503

        variant_set = {v.strip() for v in variants if v.strip()}

        def _sqlite_row_in_thread(msg: dict) -> bool:
            if str(msg.get("category") or "").lower() == "announcement":
                return False
            s = (msg.get("sender_phone") or "").strip()
            r = (msg.get("recipient_phone") or "").strip()
            return s in variant_set or r in variant_set

        messages = (
            Message.query.filter(Message.category != "announcement")
            .order_by(Message.created_at.asc())
            .limit(1000)
            .all()
        )
        items = [m.to_dict() for m in messages if _sqlite_row_in_thread(m.to_dict())]
        return jsonify({"items": items})

    @app.route("/api/messages", methods=["POST"])
    def api_messages_create():
        """Compose and send a new message."""
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if _use_shared_messages():
            role, phone, name_hint = _shared_identity()
            users = load_users()
            sender = users.get(get_current_user_phone() or get_current_farmer_phone() or "", {})
            sender_name = "Administrator" if role == "admin" else (
                sender.get("full_name")
                or name_hint
                or phone
            )

            data = request.get_json(silent=True) or {}
            fields, field_err = _parse_message_fields(data)
            if field_err:
                return jsonify({"error": field_err}), 400
            subject = fields["subject"]
            body = fields["body"]
            category = fields["category"]
            farmer_id = fields["farmer_id"]
            recipient_phone_raw = fields["recipient_phone_raw"]
            recipient_name = fields["recipient_name"]

            recipient_role = "farmer" if role == "admin" else "admin"
            recipient_phone = _normalize_phone(recipient_phone_raw) if recipient_phone_raw else ""

            if role == "admin" and not recipient_phone:
                return jsonify({"error": "recipient_phone is required for admin replies."}), 400

            if not recipient_name and recipient_phone_raw:
                recipient = users.get(recipient_phone_raw, {})
                recipient_name = recipient.get("full_name", "")

            try:
                saved = send_shared_message(
                    role=role,
                    phone=phone,
                    sender_name=sender_name,
                    recipient_role=recipient_role,
                    recipient_phone=recipient_phone,
                    recipient_name=recipient_name,
                    subject=subject,
                    body=body,
                    category=category,
                    farmer_id=farmer_id,
                )
                return jsonify({"success": True, "message": _normalize_shared_message_row(saved)}), 201
            except MessagesLoadError as e:
                msg = friendly_load_failure(
                    module_label="message send",
                    mysql_error=e.mysql_error,
                    http_error=e.http_error,
                )
                return jsonify(load_error_payload("MESSAGE_SEND_FAILED", msg)), 503
            except Exception as e:
                msg = friendly_load_failure(
                    module_label="message send",
                    mysql_error=e if isinstance(e, OperationalError) else None,
                    http_error=None if isinstance(e, OperationalError) else e,
                )
                return jsonify(load_error_payload("MESSAGE_SEND_FAILED", msg)), 503

        user_phone = (get_current_user_phone() or get_current_farmer_phone() or "")
        users = load_users()
        sender = users.get(user_phone, {})
        sender_name = "Administrator" if is_authenticated() else (
            sender.get("full_name")
            or session.get("user_name")
            or session.get("farmer_name")
            or user_phone
        )

        data = request.get_json(silent=True) or {}
        fields, field_err = _parse_message_fields(data)
        if field_err:
            return jsonify({"error": field_err}), 400
        subject = fields["subject"]
        body = fields["body"]
        category = fields["category"]
        farmer_id = fields["farmer_id"]
        recipient_phone = fields["recipient_phone_raw"]
        recipient_name = fields["recipient_name"]

        if not recipient_name and recipient_phone:
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
            farmer_id=farmer_id,
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
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if _use_shared_messages():
            role, phone, _name = _shared_identity()
            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT message_id AS id, sender_phone, sender_name, recipient_phone, recipient_name,
                               subject, body, category, farmer_id, is_read, is_starred, is_archived, created_at, read_at,
                               sender_role, recipient_role
                        FROM shared_messages WHERE message_id=%s LIMIT 1
                        """,
                        (int(message_id),),
                    )
                    msg = cur.fetchone()
                    if not msg:
                        return jsonify({"error": "Message not found."}), 404

                    # Participant check + mark read for recipient
                    is_participant = False
                    if role == "admin":
                        is_participant = (msg.get("recipient_role") == "admin" and (msg.get("recipient_phone") in ("", phone))) or (
                            msg.get("sender_role") == "admin" and msg.get("sender_phone") == phone
                        )
                    else:
                        is_participant = (msg.get("recipient_role") == "farmer" and msg.get("recipient_phone") == phone) or (
                            msg.get("sender_role") == "farmer" and msg.get("sender_phone") == phone
                        )
                    if not is_participant:
                        return jsonify({"error": "Unauthorized"}), 401

                    if int(msg.get("is_read") or 0) == 0:
                        if (msg.get("recipient_role") == role) and (
                            (role == "admin" and msg.get("recipient_phone") in ("", phone))
                            or (role == "farmer" and msg.get("recipient_phone") == phone)
                        ):
                            cur.execute(
                                "UPDATE shared_messages SET is_read=1, read_at=NOW() WHERE message_id=%s",
                                (int(message_id),),
                            )
                            msg["is_read"] = 1
                            msg["read_at"] = datetime.utcnow().isoformat()

                return jsonify({"message": msg})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        user_phone = get_current_user_phone() or get_current_farmer_phone() or ""
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
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if _use_shared_messages():
            role, phone, _name = _shared_identity()
            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT message_id, sender_role, sender_phone, recipient_role, recipient_phone, is_starred FROM shared_messages WHERE message_id=%s",
                        (int(message_id),),
                    )
                    row = cur.fetchone()
                    if not row:
                        return jsonify({"error": "Message not found."}), 404
                    allowed = False
                    if role == "admin":
                        allowed = (row.get("recipient_role") == "admin" and row.get("recipient_phone") in ("", phone)) or (
                            row.get("sender_role") == "admin" and row.get("sender_phone") == phone
                        )
                    else:
                        allowed = (row.get("recipient_role") == "farmer" and row.get("recipient_phone") == phone) or (
                            row.get("sender_role") == "farmer" and row.get("sender_phone") == phone
                        )
                    if not allowed:
                        return jsonify({"error": "Unauthorized"}), 401
                    new_val = 0 if int(row.get("is_starred") or 0) == 1 else 1
                    cur.execute("UPDATE shared_messages SET is_starred=%s WHERE message_id=%s", (new_val, int(message_id)))
                return jsonify({"success": True, "is_starred": bool(new_val)})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        msg.is_starred = not msg.is_starred
        db.session.commit()

        return jsonify({"success": True, "is_starred": msg.is_starred})

    @app.route("/api/messages/<int:message_id>/archive", methods=["POST"])
    def api_messages_archive(message_id):
        """Toggle archive on a message."""
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if _use_shared_messages():
            role, phone, _name = _shared_identity()
            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT message_id, recipient_role, recipient_phone, is_archived FROM shared_messages WHERE message_id=%s",
                        (int(message_id),),
                    )
                    row = cur.fetchone()
                    if not row:
                        return jsonify({"error": "Message not found."}), 404
                    # Only recipients can archive (mirrors inbox behavior)
                    if role == "admin":
                        if not (row.get("recipient_role") == "admin" and row.get("recipient_phone") in ("", phone)):
                            return jsonify({"error": "Unauthorized"}), 401
                    else:
                        if not (row.get("recipient_role") == "farmer" and row.get("recipient_phone") == phone):
                            return jsonify({"error": "Unauthorized"}), 401
                    new_val = 0 if int(row.get("is_archived") or 0) == 1 else 1
                    cur.execute("UPDATE shared_messages SET is_archived=%s WHERE message_id=%s", (new_val, int(message_id)))
                return jsonify({"success": True, "is_archived": bool(new_val)})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        msg.is_archived = not msg.is_archived
        db.session.commit()

        return jsonify({"success": True, "is_archived": msg.is_archived})

    @app.route("/api/messages/<int:message_id>/read", methods=["POST"])
    def api_messages_mark_read(message_id):
        """Mark a message as read."""
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if _use_shared_messages():
            role, phone, _name = _shared_identity()
            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT recipient_role, recipient_phone FROM shared_messages WHERE message_id=%s",
                        (int(message_id),),
                    )
                    row = cur.fetchone()
                    if not row:
                        return jsonify({"error": "Message not found."}), 404
                    if role == "admin":
                        if not (row.get("recipient_role") == "admin" and row.get("recipient_phone") in ("", phone)):
                            return jsonify({"error": "Unauthorized"}), 401
                    else:
                        if not (row.get("recipient_role") == "farmer" and row.get("recipient_phone") == phone):
                            return jsonify({"error": "Unauthorized"}), 401
                    cur.execute("UPDATE shared_messages SET is_read=1, read_at=NOW() WHERE message_id=%s", (int(message_id),))
                return jsonify({"success": True})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        msg.is_read = True
        msg.read_at = datetime.utcnow()
        db.session.commit()

        return jsonify({"success": True})

    @app.route("/api/messages/mark-thread-read", methods=["POST"])
    def api_messages_mark_thread_read():
        """Mark all farmer→admin messages in a thread as read (opening a chat)."""
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        farmer_phone = request.args.get("phone", "") or (request.get_json(silent=True) or {}).get("phone", "")
        variants = phone_variants(farmer_phone)
        if not variants:
            return jsonify({"error": "phone is required."}), 400

        if _use_shared_messages():
            role, my_phone, _name = _shared_identity()
            conn = None
            try:
                conn = _shared_connect()
                ph = ", ".join(["%s"] * len(variants))
                with conn.cursor() as cur:
                    if role == "admin":
                        cur.execute(
                            f"""
                            UPDATE shared_messages
                            SET is_read = 1, read_at = NOW()
                            WHERE sender_role = 'farmer'
                              AND sender_phone IN ({ph})
                              AND is_read = 0
                              AND LOWER(category) <> 'announcement'
                            """,
                            tuple(variants),
                        )
                    else:
                        cur.execute(
                            f"""
                            UPDATE shared_messages
                            SET is_read = 1, read_at = NOW()
                            WHERE recipient_role = 'farmer'
                              AND recipient_phone IN ({ph})
                              AND sender_role = 'admin'
                              AND is_read = 0
                              AND LOWER(category) <> 'announcement'
                            """,
                            tuple(variants),
                        )
                    updated = int(cur.rowcount or 0)
                return jsonify({"success": True, "updated": updated})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        return jsonify({"success": True, "updated": 0})

    @app.route("/api/messages/mark-all-read", methods=["POST"])
    def api_messages_mark_all_read():
        """Mark all inbox messages as read for the current user."""
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if _use_shared_messages():
            role, phone, _name = _shared_identity()
            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    if role == "admin":
                        cur.execute(
                            """
                            UPDATE shared_messages
                            SET is_read=1, read_at=NOW()
                            WHERE recipient_role='admin'
                              AND (recipient_phone='' OR recipient_phone=%s)
                              AND is_read=0
                            """,
                            (phone,),
                        )
                    else:
                        cur.execute(
                            """
                            UPDATE shared_messages
                            SET is_read=1, read_at=NOW()
                            WHERE recipient_role='farmer' AND recipient_phone=%s AND is_read=0
                            """,
                            (phone,),
                        )
                    updated = cur.rowcount
                return jsonify({"success": True, "updated": int(updated or 0)})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        user_phone = get_current_user_phone() or get_current_farmer_phone() or ""
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
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if _use_shared_messages():
            role, phone, _name = _shared_identity()
            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT sender_role, sender_phone, recipient_role, recipient_phone FROM shared_messages WHERE message_id=%s",
                        (int(message_id),),
                    )
                    row = cur.fetchone()
                    if not row:
                        return jsonify({"error": "Message not found."}), 404
                    # Allow delete if user is participant (admin or farmer portal).
                    allowed = False
                    if role == "admin":
                        allowed = (row.get("sender_role") == "admin" and row.get("sender_phone") == phone) or (
                            row.get("recipient_role") == "admin" and row.get("recipient_phone") in ("", phone)
                        )
                    else:
                        allowed = (row.get("sender_role") == "farmer" and row.get("sender_phone") == phone) or (
                            row.get("recipient_role") == "farmer" and row.get("recipient_phone") == phone
                        )
                    if not allowed:
                        return jsonify({"error": "Unauthorized"}), 401
                    cur.execute("DELETE FROM shared_messages WHERE message_id=%s", (int(message_id),))
                return jsonify({"success": True})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        msg = Message.query.get(message_id)
        if not msg:
            return jsonify({"error": "Message not found."}), 404

        user_phone = get_current_user_phone() or get_current_farmer_phone() or ""
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
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if app_db_params() or app_server_base():
            role, phone, _name = _shared_identity()
            try:
                unread_count = load_unread_message_count(role=role, phone=phone)
                return jsonify({"unread_count": unread_count, "ok": True})
            except Exception as e:
                msg = friendly_load_failure(
                    module_label="messages",
                    mysql_error=e if isinstance(e, OperationalError) else None,
                    http_error=None if isinstance(e, OperationalError) else e,
                )
                return jsonify(load_error_payload("MESSAGES_LOAD_FAILED", msg)), 503

        user_phone = get_current_user_phone() or get_current_farmer_phone() or ""
        count = Message.query.filter(
            (Message.recipient_phone == user_phone) | (Message.recipient_phone == ""),
            Message.is_read == False,
            Message.is_archived == False,
        ).count()

        return jsonify({"unread_count": count})
