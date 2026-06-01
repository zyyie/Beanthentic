"""Google Maps API key resolution."""

from __future__ import annotations

import os

from config.utils import load_settings

# Public sample key — shows "For development purposes only" on the map.
DEMO_GOOGLE_MAPS_API_KEY = "AIzaSyDC_FHQoHhtZA883eOefAbbzKYs58qElhg"


def get_google_maps_api_key() -> str:
    """
    Resolve Maps key: settings.json maps.google_api_key, then GOOGLE_MAPS_API_KEY env.
    Never returns the built-in demo key unless GOOGLE_MAPS_ALLOW_DEMO=1.
    """
    settings = load_settings()
    maps = settings.get("maps") if isinstance(settings.get("maps"), dict) else {}
    key = str(maps.get("google_api_key") or "").strip()
    if not key:
        key = os.getenv("GOOGLE_MAPS_API_KEY", "").strip()
    if key == DEMO_GOOGLE_MAPS_API_KEY and os.getenv("GOOGLE_MAPS_ALLOW_DEMO", "").strip() != "1":
        return ""
    return key


def google_maps_key_is_production(key: str | None = None) -> bool:
    """True when a non-demo key is configured."""
    resolved = (key if key is not None else get_google_maps_api_key()).strip()
    return bool(resolved) and resolved != DEMO_GOOGLE_MAPS_API_KEY
