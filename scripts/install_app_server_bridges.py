#!/usr/bin/env python3
"""
Install admin photo bridges on the Beanthentic-App PC (port 8080).

Usage (on the app server machine):
  python install_app_server_bridges.py "C:\\path\\to\\Beanthentic-App"

Or with no argument — uses BEANTHENTIC_APP_DIR env var or prompts.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRIDGES_SRC = ROOT / "deploy" / "app_server" / "admin_bridges.py"
MARKER = "register_admin_bridges(app)"
SNIPPET = """
_ADMIN_BRIDGES_LOADED = False
try:
    from admin_bridges import register_admin_bridges
    register_admin_bridges(app)
    _ADMIN_BRIDGES_LOADED = True
except ImportError:
    pass
except Exception as admin_bridge_err:
    import warnings
    warnings.warn(f"admin_bridges not loaded: {admin_bridge_err!s}")
"""


def patch_app_py(app_dir: Path) -> bool:
    app_py = app_dir / "app.py"
    if not app_py.is_file():
        print(f"ERROR: app.py not found in {app_dir}")
        return False
    text = app_py.read_text(encoding="utf-8")
    if MARKER in text:
        print("app.py already patched.")
        return True
    anchor = "register_farm_module = RegisterFarmModule(app)"
    if anchor in text:
        text = text.replace(anchor, SNIPPET + "\n\n" + anchor, 1)
        app_py.write_text(text, encoding="utf-8")
        print("Patched app.py (after MySQL routes)")
        return True
    anchor = 'if __name__ == "__main__":'
    if anchor not in text:
        print("ERROR: Could not find patch anchor in app.py — add manually:")
        print(SNIPPET)
        return False
    text = text.replace(anchor, SNIPPET + "\n\n" + anchor, 1)
    app_py.write_text(text, encoding="utf-8")
    print("Patched app.py")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Install admin_bridges on Beanthentic-App")
    parser.add_argument(
        "app_dir",
        nargs="?",
        help="Folder containing Beanthentic-App app.py",
    )
    args = parser.parse_args()
    app_dir = Path(args.app_dir).resolve() if args.app_dir else None
    if not app_dir or not app_dir.is_dir():
        print("Usage: python install_app_server_bridges.py C:\\path\\to\\Beanthentic-App")
        return 1
    if not BRIDGES_SRC.is_file():
        print(f"ERROR: Missing {BRIDGES_SRC}")
        return 1
    dest = app_dir / "admin_bridges.py"
    shutil.copy2(BRIDGES_SRC, dest)
    print(f"Copied admin_bridges.py -> {dest}")
    if not patch_app_py(app_dir):
        return 1
    print()
    print("Done. On this PC run:")
    print("  pip install pymysql")
    print("  python app.py")
    print()
    print("Then test in browser:")
    print("  http://THIS_PC_IP:8080/api/admin_farmer_photos.php")
    print("  (should show JSON, not 404 or PHP source)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
