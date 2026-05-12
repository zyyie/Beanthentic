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

from config.models import Message, db
from config.utils import (
    get_current_farmer_phone,
    get_current_user_phone,
    is_authenticated,
    is_farmer_authenticated,
    load_users,
    log_activity,
)


def _shared_db_params() -> dict | None:
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


def _shared_connect():
    params = _shared_db_params()
    if not params:
        return None
    conn = pymysql.connect(**params)
    _ensure_shared_messages_table(conn)
    return conn


def _ensure_shared_messages_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS shared_messages (
              message_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
              sender_role ENUM('admin','farmer') NOT NULL,
              sender_phone VARCHAR(32) NOT NULL,
              sender_name VARCHAR(255) NULL,
              recipient_role ENUM('admin','farmer') NOT NULL,
              recipient_phone VARCHAR(32) NOT NULL DEFAULT '',
              recipient_name VARCHAR(255) NULL,
              subject VARCHAR(300) NOT NULL,
              body TEXT NOT NULL,
              category VARCHAR(30) NOT NULL DEFAULT 'general',
              farmer_id BIGINT UNSIGNED NULL,
              is_read TINYINT(1) NOT NULL DEFAULT 0,
              is_starred TINYINT(1) NOT NULL DEFAULT 0,
              is_archived TINYINT(1) NOT NULL DEFAULT 0,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              read_at DATETIME NULL,
              INDEX idx_sm_recipient (recipient_role, recipient_phone, is_read, is_archived),
              INDEX idx_sm_sender (sender_role, sender_phone),
              INDEX idx_sm_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )


def _normalize_phone(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    digits = re.sub(r"\D+", "", s)
    if not digits:
        return ""
    if digits.startswith("0"):
        digits = digits[1:]
    if digits.startswith("63"):
        digits = digits[2:]
    if len(digits) == 10 and digits.startswith("9"):
        return "+63" + digits
    if s.startswith("+"):
        return s
    return s


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

    @app.route("/api/messages", methods=["GET"])
    def api_messages_list():
        """List messages for the current user (inbox view)."""
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        # Shared XAMPP DB mode (2-way with the mobile app)
        if _shared_db_params():
            role, phone, _name = _shared_identity()
            folder = request.args.get("folder", "inbox")  # inbox | sent | starred | archived
            search = (request.args.get("search", "") or "").strip().lower()
            category = request.args.get("category", "").strip().lower()
            limit = min(int(request.args.get("limit", "100")), 500)

            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    where = []
                    args = []

                    if folder == "inbox":
                        if role == "admin":
                            where.append("recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s) AND is_archived=0")
                            args.append(phone)
                        else:
                            where.append("recipient_role='farmer' AND recipient_phone=%s AND is_archived=0")
                            args.append(phone)
                    elif folder == "sent":
                        where.append("sender_role=%s AND sender_phone=%s")
                        args.extend([role, phone])
                    elif folder == "starred":
                        if role == "admin":
                            where.append(
                                "((recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s)) OR (sender_role='admin' AND sender_phone=%s)) AND is_starred=1"
                            )
                            args.extend([phone, phone])
                        else:
                            where.append(
                                "((recipient_role='farmer' AND recipient_phone=%s) OR (sender_role='farmer' AND sender_phone=%s)) AND is_starred=1"
                            )
                            args.extend([phone, phone])
                    elif folder == "archived":
                        if role == "admin":
                            where.append("recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s) AND is_archived=1")
                            args.append(phone)
                        else:
                            where.append("recipient_role='farmer' AND recipient_phone=%s AND is_archived=1")
                            args.append(phone)
                    else:
                        if role == "admin":
                            where.append("recipient_role='admin' AND (recipient_phone='' OR recipient_phone=%s) AND is_archived=0")
                            args.append(phone)
                        else:
                            where.append("recipient_role='farmer' AND recipient_phone=%s AND is_archived=0")
                            args.append(phone)

                    if category:
                        where.append("category=%s")
                        args.append(category)

                    cur.execute(
                        """
                        SELECT
                          message_id AS id,
                          sender_phone, sender_name,
                          recipient_phone, recipient_name,
                          subject, body, category, farmer_id,
                          is_read, is_starred, is_archived,
                          created_at, read_at
                        FROM shared_messages
                        WHERE """
                        + " AND ".join(where)
                        + " ORDER BY created_at DESC, message_id DESC LIMIT %s",
                        tuple(args + [limit]),
                    )
                    items = cur.fetchall() or []

                    if search:
                        s = search
                        items = [
                            m
                            for m in items
                            if s in (str(m.get("subject") or "").lower())
                            or s in (str(m.get("body") or "").lower())
                            or s in (str(m.get("sender_name") or "").lower())
                            or s in (str(m.get("recipient_name") or "").lower())
                        ]

                    # Unread count badge
                    if role == "admin":
                        cur.execute(
                            """
                            SELECT COUNT(*) AS c
                            FROM shared_messages
                            WHERE recipient_role='admin'
                              AND (recipient_phone='' OR recipient_phone=%s)
                              AND is_read=0 AND is_archived=0
                            """,
                            (phone,),
                        )
                    else:
                        cur.execute(
                            """
                            SELECT COUNT(*) AS c
                            FROM shared_messages
                            WHERE recipient_role='farmer' AND recipient_phone=%s
                              AND is_read=0 AND is_archived=0
                            """,
                            (phone,),
                        )
                    unread_count = int((cur.fetchone() or {}).get("c") or 0)

                return jsonify({"items": items, "unread_count": unread_count})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        user_phone = (get_current_user_phone() or get_current_farmer_phone() or "")
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
        if not (is_authenticated() or is_farmer_authenticated()):
            return jsonify({"error": "Unauthorized"}), 401

        if _shared_db_params():
            role, phone, name_hint = _shared_identity()
            users = load_users()
            sender = users.get(get_current_user_phone() or get_current_farmer_phone() or "", {})
            sender_name = (
                sender.get("full_name")
                or name_hint
                or phone
            )

            data = request.get_json(silent=True) or {}
            subject = (data.get("subject") or "").strip()
            body = (data.get("body") or "").strip()
            category = (data.get("category") or "general").strip().lower()
            recipient_phone_raw = (data.get("recipient_phone") or "").strip()
            farmer_id = data.get("farmer_id")

            if not subject:
                return jsonify({"error": "Subject is required."}), 400
            if not body:
                return jsonify({"error": "Message body is required."}), 400
            if category not in ("general", "farmer-update", "farmers", "announcement", "reminder"):
                category = "general"

            recipient_role = "farmer" if role == "admin" else "admin"
            recipient_phone = _normalize_phone(recipient_phone_raw) if recipient_phone_raw else ""

            # In admin->farmer flow, recipient_phone is required.
            if role == "admin" and not recipient_phone:
                return jsonify({"error": "recipient_phone is required for admin replies."}), 400

            recipient_name = ""
            if recipient_phone_raw:
                recipient = users.get(recipient_phone_raw, {})
                recipient_name = recipient.get("full_name", "")

            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO shared_messages
                          (sender_role, sender_phone, sender_name,
                           recipient_role, recipient_phone, recipient_name,
                           subject, body, category, farmer_id,
                           is_read, is_starred, is_archived)
                        VALUES
                          (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0, 0, 0)
                        """,
                        (
                            role,
                            phone,
                            sender_name,
                            recipient_role,
                            recipient_phone,
                            recipient_name,
                            subject[:300],
                            body,
                            category[:30],
                            int(farmer_id) if farmer_id else None,
                        ),
                    )
                    mid = cur.lastrowid
                return jsonify({"success": True, "message": {"id": int(mid)}}), 201
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        user_phone = (get_current_user_phone() or get_current_farmer_phone() or "")
        users = load_users()
        sender = users.get(user_phone, {})
        sender_name = (
            sender.get("full_name")
            or session.get("user_name")
            or session.get("farmer_name")
            or user_phone
        )

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
        if category not in ("general", "farmer-update", "farmers", "announcement", "reminder"):
            category = "general"

        # Resolve recipient name (admin users live in JSON; farmers may be unknown here)
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

        if _shared_db_params():
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

        if _shared_db_params():
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
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        if _shared_db_params():
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
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        if _shared_db_params():
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

    @app.route("/api/messages/mark-all-read", methods=["POST"])
    def api_messages_mark_all_read():
        """Mark all inbox messages as read for the current user."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        if _shared_db_params():
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

        if _shared_db_params():
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

        if _shared_db_params():
            role, phone, _name = _shared_identity()
            conn = None
            try:
                conn = _shared_connect()
                with conn.cursor() as cur:
                    if role == "admin":
                        cur.execute(
                            """
                            SELECT COUNT(*) AS c
                            FROM shared_messages
                            WHERE recipient_role='admin'
                              AND (recipient_phone='' OR recipient_phone=%s)
                              AND is_read=0 AND is_archived=0
                            """,
                            (phone,),
                        )
                    else:
                        cur.execute(
                            """
                            SELECT COUNT(*) AS c
                            FROM shared_messages
                            WHERE recipient_role='farmer' AND recipient_phone=%s
                              AND is_read=0 AND is_archived=0
                            """,
                            (phone,),
                        )
                    count = int((cur.fetchone() or {}).get("c") or 0)
                return jsonify({"unread_count": count})
            except Exception as e:
                return jsonify({"error": "APP_DB_UNREACHABLE", "detail": str(e)}), 503
            finally:
                if conn:
                    conn.close()

        user_phone = get_current_user_phone() or ""
        count = Message.query.filter(
            (Message.recipient_phone == user_phone) | (Message.recipient_phone == ""),
            Message.is_read == False,
            Message.is_archived == False,
        ).count()

        return jsonify({"unread_count": count})
