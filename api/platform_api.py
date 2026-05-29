"""
Platform API endpoints for Beanthentic application.

Provides endpoints for notifications, social links, clients, maps, and updates.
"""

from datetime import datetime

from flask import jsonify, request

from config.models import (
    GIFarmersContribution,
    Map,
    Notification,
    Social,
    Update,
    db,
)
from config.security import api_error
from config.validation import (
    NOTIFICATION_MESSAGE_MAX,
    UPDATE_CONTENT_MAX,
    UPDATE_TITLE_MAX,
    clean_text,
    validate_positive_int,
    validate_url,
)
from config.utils import get_current_user_phone, is_authenticated, log_activity

def register_platform_routes(app):
    """Register platform-related API routes with the Flask app."""

    @app.route("/api/notifications", methods=["GET", "POST"])
    def api_notifications():
        """
        Handle notifications.
        
        MOBILE APP CONNECTION:
        - GET /api/notifications?account_id=...
        - POST /api/notifications (create alert)
        """
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        if request.method == "GET":
            account_id = request.args.get("account_id", type=int)
            query = Notification.query
            if account_id:
                query = query.filter(Notification.account_id == account_id)
            notifications = query.order_by(Notification.created_at.desc()).all()
            return jsonify([{
                "id": n.id,
                "account_id": n.account_id,
                "message": n.message,
                "type": n.type,
                "is_read": n.is_read,
                "created_at": n.created_at.isoformat()
            } for n in notifications])

        payload = request.get_json(silent=True) or {}
        try:
            message = clean_text(
                payload.get("message"), NOTIFICATION_MESSAGE_MAX, "Message", allow_empty=False
            )
        except ValueError as exc:
            return api_error(str(exc), 400)
        ntype = (payload.get("type") or "info").strip().lower()
        if ntype not in ("info", "warning", "success", "error"):
            ntype = "info"
        account_id = payload.get("account_id")
        if account_id is not None:
            ok_aid, aid_err, account_id = validate_positive_int(account_id, field="account_id", minimum=1)
            if not ok_aid:
                return api_error(aid_err, 400)
        n = Notification(
            account_id=account_id,
            message=message,
            type=ntype,
            created_at=datetime.utcnow(),
        )
        db.session.add(n)
        db.session.commit()
        return jsonify({"success": True, "id": n.id})

    @app.route("/api/social", methods=["GET", "POST"])
    def api_social():
        """Handle social media links."""
        if request.method == "GET":
            if not is_authenticated():
                return jsonify({"error": "Unauthorized"}), 401
            account_id = request.args.get("account_id", type=int)
            query = Social.query
            if account_id:
                query = query.filter(Social.account_id == account_id)
            socials = query.all()
            return jsonify([{
                "id": s.id,
                "account_id": s.account_id,
                "url": s.url
            } for s in socials])

        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        payload = request.get_json(silent=True) or {}
        ok_url, url_err, url = validate_url(payload.get("url"))
        if not ok_url:
            return api_error(url_err, 400)
        account_id = payload.get("account_id")
        if account_id is not None:
            ok_aid, aid_err, account_id = validate_positive_int(account_id, field="account_id", minimum=1)
            if not ok_aid:
                return api_error(aid_err, 400)
        s = Social(account_id=account_id, url=url)
        db.session.add(s)
        db.session.commit()
        return jsonify({"success": True, "id": s.id})

    @app.route("/api/updates", methods=["GET", "POST"])
    def api_updates():
        """
        Handle platform updates (News Feed).
        
        MOBILE APP CONNECTION:
        - GET /api/updates (fetch all posts)
        - POST /api/updates (create a new post)
        """
        if request.method == "GET":
            if not is_authenticated():
                return jsonify({"error": "Unauthorized"}), 401
            updates = Update.query.order_by(Update.created_at.desc()).all()
            return jsonify([{
                "id": u.id,
                "admin_id": u.admin_id,
                "title": u.title,
                "content": u.content,
                "image_url": u.image_url,
                "created_at": u.created_at.isoformat(),
                "likes_count": u.likes_count
            } for u in updates])

        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        payload = request.get_json(silent=True) or {}
        try:
            title = clean_text(payload.get("title"), UPDATE_TITLE_MAX, "Title", allow_empty=False)
            content = clean_text(payload.get("content"), UPDATE_CONTENT_MAX, "Content", allow_empty=False)
        except ValueError as exc:
            return api_error(str(exc), 400)
        image_url = (payload.get("image_url") or "").strip()
        if image_url:
            ok_img, img_err, image_url = validate_url(image_url, required=True)
            if not ok_img:
                return api_error(img_err, 400)
        u = Update(
            admin_id=payload.get("admin_id"),
            title=title,
            content=content,
            image_url=image_url or None,
            created_at=datetime.utcnow(),
        )
        db.session.add(u)
        db.session.commit()
        
        user_phone = get_current_user_phone()
        log_activity(user_phone, "CREATE_UPDATE", f"Created update: {u.title}", request.remote_addr)
        
        return jsonify({"success": True, "id": u.id})

    @app.route("/api/maps", methods=["GET", "POST"])
    def api_maps():
        """Handle geographic information."""
        if request.method == "GET":
            if not is_authenticated():
                return jsonify({"error": "Unauthorized"}), 401
            farmer_id = request.args.get("farmer_id", type=int)
            query = Map.query
            if farmer_id:
                query = query.filter(Map.farmer_id == farmer_id)
            maps = query.all()
            return jsonify([{
                "id": m.id,
                "farmer_id": m.farmer_id,
                "coffee_variety": m.coffee_variety,
                "barangay_landmarks": m.barangay_landmarks
            } for m in maps])

        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        payload = request.get_json(silent=True) or {}
        ok_fid, fid_err, farmer_id = validate_positive_int(
            payload.get("farmer_id"), field="farmer_id", minimum=1
        )
        if not ok_fid:
            return api_error(fid_err, 400)
        try:
            coffee_variety = clean_text(
                payload.get("coffee_variety"), 64, "Coffee variety", allow_empty=True
            )
            barangay_landmarks = clean_text(
                payload.get("barangay_landmarks"), 500, "Barangay landmarks", allow_empty=True
            )
        except ValueError as exc:
            return api_error(str(exc), 400)
        m = Map(
            farmer_id=farmer_id,
            coffee_variety=coffee_variety,
            barangay_landmarks=barangay_landmarks,
        )
        db.session.add(m)
        db.session.commit()
        return jsonify({"success": True, "id": m.id})

    @app.route("/api/gi-contributions", methods=["GET", "POST"])
    def api_gi_contributions():
        """Handle GI contributions."""
        if request.method == "GET":
            if not is_authenticated():
                return jsonify({"error": "Unauthorized"}), 401
            farmer_id = request.args.get("farmer_id", type=int)
            query = GIFarmersContribution.query
            if farmer_id:
                query = query.filter(GIFarmersContribution.farmer_id == farmer_id)
            contributions = query.all()
            return jsonify([{
                "farmer_id": c.farmer_id,
                "ipophil_id": c.ipophil_id,
                "gi_document": c.gi_document,
                "images": c.images
            } for c in contributions])

        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        # POST - Add contribution
        payload = request.get_json(silent=True) or {}
        c = GIFarmersContribution(
            farmer_id=payload.get("farmer_id"),
            ipophil_id=payload.get("ipophil_id"),
            gi_document=payload.get("gi_document"),
            images=payload.get("images")
        )
        db.session.add(c)
        db.session.commit()
        return jsonify({"success": True})
