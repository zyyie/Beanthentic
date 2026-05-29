"""
Security helpers: auth guards, safe API errors, session configuration.
"""

from __future__ import annotations

import os
from functools import wraps

from flask import Flask, jsonify, redirect, request, session, url_for

from config.utils import is_authenticated, is_farmer_authenticated


def configure_app_security(app: Flask) -> None:
    secret = os.getenv("FLASK_SECRET_KEY", "").strip() or os.getenv("SECRET_KEY", "").strip()
    if secret:
        app.secret_key = secret
    elif not app.secret_key or app.secret_key == "beanthentic-dev-secret-change-this":
        app.logger.warning(
            "Using default secret key. Set FLASK_SECRET_KEY in production."
        )

    app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
    app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")
    secure_cookies = os.getenv("SESSION_COOKIE_SECURE", "").strip().lower() in ("1", "true", "yes")
    app.config.setdefault("SESSION_COOKIE_SECURE", secure_cookies)


def api_error(message: str, status: int = 400, *, code: str | None = None):
    body = {"error": code or "VALIDATION_ERROR", "message": message}
    return jsonify(body), status


def safe_error_message(exc: BaseException, *, public: str = "An unexpected error occurred.") -> str:
    """Avoid leaking stack traces / SQL details to clients."""
    text = str(exc).lower()
    if any(x in text for x in ("mysql", "pymysql", "sqlalchemy", "operationalerror", "access denied")):
        return "Database operation failed. Check connection settings and try again."
    if "timed out" in text or "can't connect" in text:
        return "Could not reach the database server."
    return public


def wants_json() -> bool:
    if request.path.startswith("/api/"):
        return True
    accept = request.accept_mimetypes
    return accept.best == "application/json" and accept[accept.best] > accept["text/html"]


def require_admin(view):
    """Require admin session (user_phone). HTML routes redirect to login."""

    @wraps(view)
    def wrapped(*args, **kwargs):
        if not is_authenticated():
            if wants_json():
                return jsonify({"error": "Unauthorized", "message": "Admin login required."}), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped


def require_admin_or_farmer(view):
    """Require either admin or farmer portal session."""

    @wraps(view)
    def wrapped(*args, **kwargs):
        if not (is_authenticated() or is_farmer_authenticated()):
            if wants_json():
                return jsonify({"error": "Unauthorized", "message": "Login required."}), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped
