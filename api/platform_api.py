"""
Platform API endpoints for Beanthentic application.

Provides endpoints for notifications, social links, clients, maps, and updates.
"""

from datetime import datetime
from flask import jsonify, request
from config.models import (
    db, Notification, Social, Client, Map, Update, 
    GIFarmersContribution, AdminNotification, Farmer
)
from config.utils import is_authenticated, log_activity, get_current_user_phone

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

        # POST - Create notification
        payload = request.get_json(silent=True) or {}
        n = Notification(
            account_id=payload.get("account_id"),
            message=payload.get("message"),
            type=payload.get("type", "info"),
            created_at=datetime.utcnow()
        )
        db.session.add(n)
        db.session.commit()
        return jsonify({"success": True, "id": n.id})

    @app.route("/api/social", methods=["GET", "POST"])
    def api_social():
        """Handle social media links."""
        if request.method == "GET":
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

        # POST - Add/Update social link
        payload = request.get_json(silent=True) or {}
        s = Social(
            account_id=payload.get("account_id"),
            url=payload.get("url")
        )
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

        # POST - Create update
        payload = request.get_json(silent=True) or {}
        u = Update(
            admin_id=payload.get("admin_id"),
            title=payload.get("title"),
            content=payload.get("content"),
            image_url=payload.get("image_url"),
            created_at=datetime.utcnow()
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

        # POST - Add map info
        payload = request.get_json(silent=True) or {}
        m = Map(
            farmer_id=payload.get("farmer_id"),
            coffee_variety=payload.get("coffee_variety"),
            barangay_landmarks=payload.get("barangay_landmarks")
        )
        db.session.add(m)
        db.session.commit()
        return jsonify({"success": True, "id": m.id})

    @app.route("/api/gi-contributions", methods=["GET", "POST"])
    def api_gi_contributions():
        """Handle GI contributions."""
        if request.method == "GET":
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
