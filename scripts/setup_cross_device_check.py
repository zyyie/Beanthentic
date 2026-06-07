#!/usr/bin/env python3
"""
Cross-device setup checker for Beanthentic (admin) + Beanthentic-App (XAMPP PC).

Run from Beanthentic folder on the ADMIN PC (where web.py runs):
  python scripts/setup_cross_device_check.py
  python scripts/setup_cross_device_check.py --app-dir "C:\\path\\to\\Beanthentic-App"
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import socket
import sys
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP_DIR = ROOT.parent / "Beanthentic-App"

BRIDGE_TESTS = [
    "admin_farmer_data.php",
    "admin_farmer_photos.php",
    "admin_ipophl_documents.php?action=list&limit=1",
    "admin_shared_messages.php?role=admin&limit=1",
]


def guess_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    return ""


def check_import(module: str) -> tuple[bool, str]:
    try:
        __import__(module)
        return True, ""
    except ImportError as e:
        return False, str(e)


def probe_url(url: str, timeout: float = 5.0) -> tuple[bool, str]:
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw) if raw else {}
        if isinstance(data, dict) and data.get("ok") is True:
            return True, ""
        return False, str(data.get("error") or data.get("detail") or raw[:200])
    except Exception as e:
        return False, str(e)


def main() -> int:
    parser = argparse.ArgumentParser(description="Check cross-device Beanthentic setup")
    parser.add_argument(
        "--app-dir",
        default=str(DEFAULT_APP_DIR),
        help="Path to Beanthentic-App folder (XAMPP PC project copy for local checks)",
    )
    args = parser.parse_args()
    app_dir = Path(args.app_dir).resolve()

    sys.path.insert(0, str(ROOT))
    from config.app_connection import (
        app_server_base,
        probe_app_server_http,
        read_connection_settings,
    )

    print("=" * 60)
    print("Beanthentic cross-device setup check")
    print("=" * 60)
    admin_lan = guess_lan_ip()
    print(f"\nThis PC (admin) LAN IP: {admin_lan or '(unknown)'}")
    print(f"Admin web URL: http://{admin_lan or '127.0.0.1'}:5000")
    print(f"Diagnostic:    http://{admin_lan or '127.0.0.1'}:5000/api/connection-status")

    conn = read_connection_settings()
    print("\n--- settings.json connection ---")
    print(json.dumps(conn, indent=2))

    app_base = app_server_base()
    if not app_base:
        print("\nFAIL: app_server_base not set.")
        print("Fix: http://<XAMPP-PC-IP>:5000/connection-settings")
        return 1

    if ":5000" in app_base and ":8080" not in app_base:
        print(f"\nWARN: app_server_base looks like admin port: {app_base}")
        print("     Should be http://<XAMPP-PC-IP>:8080 (Beanthentic-App app.py)")

    print(f"\n--- Admin Python deps (this PC) ---")
    for mod in ("flask", "flask_sqlalchemy", "pymysql"):
        ok, err = check_import(mod)
        print(f"  [{'OK' if ok else 'MISSING'}] {mod}" + (f" — {err}" if not ok else ""))

    print(f"\n--- App server HTTP ({app_base}) ---")
    http_ok, http_used, http_err = probe_app_server_http(timeout=6.0)
    if http_ok:
        print(f"  [OK] Reachable @ {http_used}")
    else:
        print(f"  [FAIL] {http_err}")
        print("\n  On the XAMPP PC (Beanthentic-App folder):")
        print("    1. Start XAMPP MySQL")
        print("    2. run_app_server.bat  (or: pip install -r requirements.txt && python app.py)")
        print("    3. Windows Firewall: allow inbound TCP 8080")
        return 1

    for bridge in BRIDGE_TESTS:
        url = f"{http_used.rstrip('/')}/api/{bridge}"
        ok, err = probe_url(url)
        label = bridge.split("?")[0]
        if ok:
            print(f"  [OK] {label}")
        else:
            print(f"  [FAIL] {label} — {err}")
            if label == "admin_farmer_photos.php":
                print("       Fix: ensure admin_bridges is registered in app.py (restart app.py)")
            if label.startswith("admin_ipophl"):
                print("       Fix: update beanthentic_mysql_api.py and restart app.py")

    if app_dir.is_dir():
        app_py = app_dir / "app.py"
        text = app_py.read_text(encoding="utf-8") if app_py.is_file() else ""
        print(f"\n--- Local app.py check ({app_dir}) ---")
        print(f"  register_admin_bridges: {'YES' if 'register_admin_bridges' in text else 'NO — add to app.py'}")
        print(f"  admin_bridges.py exists: {(app_dir / 'admin_bridges.py').is_file()}")

    print("\n--- Phone (Beanthentic Android app) ---")
    host = app_base.replace("http://", "").replace("https://", "").split("/")[0]
    phone_host = host.split(":")[0] if ":" in host else host
    print(f"  Server URL must be: http://{phone_host}:8080")
    print("  NOT the admin :5000 URL.")

    print("\n--- Optional: MySQL direct from admin PC ---")
    try:
        from api.gi_contributions_api import probe_app_mysql

        mysql_ok, mysql_err = probe_app_mysql(timeout=4.0)
        if mysql_ok:
            print("  [OK] MySQL port 3306 reachable (faster than HTTP-only)")
        else:
            print(f"  [SKIP] MySQL not reachable — HTTP bridge on :8080 is enough")
            print(f"         ({mysql_err[:120]}...)")
    except Exception:
        pass

    print("\n" + "=" * 60)
    print("Setup looks OK if all [OK] above.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
