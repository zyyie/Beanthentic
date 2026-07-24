"""Supabase connection settings UI (anon key — no LAN)."""

from __future__ import annotations

from pathlib import Path

from flask import redirect, request

import beanthentic_env
from config.security import require_admin


def register_connection_settings_routes(app, *, settings_path: Path, read_settings, write_connection_settings) -> None:
    @app.route("/connection-settings", methods=["GET", "POST"])
    @require_admin
    def connection_settings():
        form_error = ""
        if request.method == "POST":
            sb_url = (request.form.get("supabase_url") or "").strip().rstrip("/")
            anon_key = (request.form.get("supabase_anon_key") or "").strip()
            project_ref = (request.form.get("supabase_project_ref") or "").strip()

            if not sb_url:
                form_error = "Supabase URL is required"
            elif not anon_key:
                prev = read_settings().get("connection") or {}
                anon_key = str(prev.get("supabase_anon_key") or beanthentic_env.supabase_anon_key() or "").strip()
                if not anon_key:
                    form_error = "Supabase anon key is required"

            if not form_error and (not sb_url.startswith("https://") or ".supabase.co" not in sb_url):
                form_error = "Supabase URL must look like https://YOUR_REF.supabase.co"

            if not form_error:
                conn_settings = {"supabase_url": sb_url, "supabase_anon_key": anon_key}
                if project_ref:
                    conn_settings["supabase_project_ref"] = project_ref
                write_connection_settings(conn_settings)

                env_path = settings_path.parent / ".env"
                try:
                    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.is_file() else []
                except OSError:
                    lines = []
                updates = {
                    "BEANTHENTIC_SUPABASE_URL": sb_url,
                    "BEANTHENTIC_SUPABASE_ANON_KEY": anon_key,
                }
                if project_ref:
                    updates["BEANTHENTIC_SUPABASE_PROJECT_REF"] = project_ref
                out: list[str] = []
                seen: set[str] = set()
                for line in lines:
                    key = line.split("=", 1)[0].strip() if "=" in line and not line.strip().startswith("#") else ""
                    if key in updates:
                        out.append(f"{key}={updates[key]}")
                        seen.add(key)
                    else:
                        out.append(line)
                for key, val in updates.items():
                    if key not in seen:
                        out.append(f"{key}={val}")
                env_path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")

                from config.supabase_client import reset_client

                reset_client()
                beanthentic_env.sync_settings_connection(settings_path)
                return redirect("/connection-settings?saved=1")

        from config.supabase_client import is_configured, verify_connection

        conn = read_settings().get("connection") or {}
        saved = (request.args.get("saved") or "").strip() == "1"
        sb_url = str(conn.get("supabase_url") or beanthentic_env.supabase_url() or "")
        anon_masked = "(set)" if (conn.get("supabase_anon_key") or beanthentic_env.supabase_anon_key()) else "(not set)"
        project_ref = str(conn.get("supabase_project_ref") or beanthentic_env.supabase_project_ref() or "")
        sb_ok, sb_err = verify_connection() if is_configured() else (False, "Not configured")
        probe_line = (
            "<p class='ok'>Supabase OK — anon key can read the database.</p>"
            if sb_ok
            else f"<p style='color:#b91c1c;'>Supabase: {sb_err}</p>"
        )

        return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Supabase Connection</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 24px; max-width: 720px; }}
  </style>
</head>
<body>
  <h1>Supabase Connection</h1>
  <p>Admin, App, and Client use the same Supabase URL + anon key. No LAN IPs.</p>
  <p>Config API: <a href="/api/supabase-config">/api/supabase-config</a></p>
  {"<p class='ok'>Saved.</p>" if saved else ""}
  {probe_line}
  {f"<p style='color:#b91c1c;'>{form_error}</p>" if form_error else ""}
  <form method="post">
    <label>Supabase URL</label><br>
    <input name="supabase_url" value="{sb_url}" style="width:100%;padding:8px;" required /><br><br>
    <label>Supabase anon key</label><br>
    <input name="supabase_anon_key" value="" placeholder="Leave blank to keep: {anon_masked}" style="width:100%;padding:8px;" /><br><br>
    <label>Project ref</label><br>
    <input name="supabase_project_ref" value="{project_ref}" style="width:100%;padding:8px;" /><br><br>
    <button type="submit">Save</button>
  </form>
</body>
</html>"""
