"""
Farmer portal routes.

Provides a lightweight login and a farmer-facing messaging UI so
farmers can reply to admin messages.
"""

from flask import redirect, render_template, request, session, url_for

from config.utils import get_current_farmer_phone, is_farmer_authenticated, log_activity


def register_farmer_portal_routes(app):
    @app.route("/farmer/login", methods=["GET", "POST"])
    def farmer_login():
        error = ""
        if request.method == "POST":
            phone = (request.form.get("phone") or "").strip()
            name = (request.form.get("name") or "").strip()

            if not phone:
                error = "Phone number is required."
            elif not phone.isdigit():
                error = "Phone number must contain only numbers."
            elif len(phone) != 10:
                error = "Phone number must be exactly 10 digits (e.g., 9123456789)."
            else:
                session["farmer_phone"] = phone
                session["farmer_name"] = name or f"Farmer +63{phone}"
                try:
                    log_activity(phone, "FARMER_LOGIN", "Farmer logged in", request.remote_addr)
                except Exception:
                    pass
                return redirect(url_for("farmer_messages"))

        return render_template("farmer/login.html", error=error)

    @app.route("/farmer/logout")
    def farmer_logout():
        phone = get_current_farmer_phone() or ""
        if phone:
            try:
                log_activity(phone, "FARMER_LOGOUT", "Farmer logged out", request.remote_addr)
            except Exception:
                pass
        session.pop("farmer_phone", None)
        session.pop("farmer_name", None)
        return redirect(url_for("farmer_login"))

    @app.route("/farmer/messages")
    def farmer_messages():
        if not is_farmer_authenticated():
            return redirect(url_for("farmer_login"))
        return render_template(
            "farmer/messages.html",
            farmer_phone=session.get("farmer_phone", ""),
            farmer_name=session.get("farmer_name", ""),
        )

