"""Stadia Maps API key resolution."""

from __future__ import annotations

import os

from config.utils import load_settings


def get_stadia_maps_api_key() -> str:
    """
    Resolve Stadia Maps key: settings.json maps.stadia_api_key, then STADIA_MAPS_API_KEY env.

    Localhost works without a key (Stadia dev rate limits). Production should use domain auth
    in the Stadia dashboard or pass an API key here.
    """
    settings = load_settings()
    maps = settings.get("maps") if isinstance(settings.get("maps"), dict) else {}
    key = str(maps.get("stadia_api_key") or maps.get("stadia_maps_api_key") or "").strip()
    if not key:
        key = os.getenv("STADIA_MAPS_API_KEY", "").strip()
    return key


def stadia_maps_key_is_production(key: str | None = None) -> bool:
    """True when a non-empty Stadia API key is configured."""
    return bool((key if key is not None else get_stadia_maps_api_key()).strip())
