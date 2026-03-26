from __future__ import annotations

import json
from pathlib import Path

from flask import Flask, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__, template_folder=".", static_folder=".", static_url_path="")
app.secret_key = "beanthentic-dev-secret-change-this"

USER_DB = Path(__file__).resolve().parent / "users.json"


def load_users() -> dict:
    if not USER_DB.exists():
        return {}
    try:
        return json.loads(USER_DB.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_users(users: dict) -> None:
    USER_DB.write_text(json.dumps(users, indent=2), encoding="utf-8")


@app.route("/")
def home():
    if session.get("user_email"):
        return redirect(url_for("dashboard"))
    return redirect(url_for("signup"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
    error = ""
    success = ""

    if request.method == "POST":
        full_name = request.form.get("fullName", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirmPassword", "")

        if not full_name or not email or not password or not confirm_password:
            error = "Please fill in all fields."
        elif password != confirm_password:
            error = "Passwords do not match."
        else:
            users = load_users()
            if email in users:
                error = "Email is already registered."
            else:
                users[email] = {
                    "full_name": full_name,
                    "password_hash": generate_password_hash(password),
                }
                save_users(users)
                success = "Signup successful. You can now log in."

    return render_template("admin/signup.html", error=error, success=success)


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""

    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        users = load_users()
        user = users.get(email)

        if not user or not check_password_hash(user.get("password_hash", ""), password):
            error = "Invalid email or password."
        else:
            session["user_email"] = email
            session["user_name"] = user.get("full_name", "Admin")
            return redirect(url_for("dashboard"))

    return render_template("admin/login.html", error=error)


@app.route("/dashboard")
def dashboard():
    if not session.get("user_email"):
        return redirect(url_for("login"))
    return render_template("dashboard.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


if __name__ == "__main__":
    app.run(debug=True)
