"""
Shared Supabase client (anon / publishable key) for Admin, App, and Client.

All three apps use the same BEANTHENTIC_SUPABASE_URL + BEANTHENTIC_SUPABASE_ANON_KEY.
No LAN IPs or local app-server HTTP bridges.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import beanthentic_env
from config.app_connection import is_transient_socket_error

_client: Any | None = None


def supabase_url() -> str:
    return beanthentic_env.supabase_url()


def supabase_anon_key() -> str:
    return beanthentic_env.supabase_anon_key()


def is_configured() -> bool:
    return bool(supabase_url() and supabase_anon_key())


def public_config() -> dict:
    """Safe to expose to app/client frontends (anon key is public by design)."""
    ref = beanthentic_env.supabase_project_ref()
    return {
        "supabase_url": supabase_url(),
        "supabase_anon_key": supabase_anon_key(),
        "supabase_project_ref": ref or None,
    }


@lru_cache(maxsize=1)
def _create_client():
    from supabase import create_client

    url = supabase_url()
    key = supabase_anon_key()
    if not url or not key:
        raise RuntimeError(
            "Supabase not configured. Set BEANTHENTIC_SUPABASE_URL and "
            "BEANTHENTIC_SUPABASE_ANON_KEY in .env (Dashboard → Project Settings → API)."
        )
    return create_client(url, key)


def get_client():
    """Return cached supabase-py client using the anon key."""
    global _client
    if _client is None:
        _client = _create_client()
    return _client


def reset_client() -> None:
    global _client
    _client = None
    _create_client.cache_clear()


def supabase_rest_get(
    table: str,
    *,
    select: str = "*",
    order: str | None = None,
    limit: int | None = None,
    filters: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> list[dict]:
    """
    Query Supabase PostgREST via urllib (more stable than supabase-py on Windows).
    filters: PostgREST column filters, e.g. {"current_phase": "eq.admin_submission"}.
    """
    url_base = supabase_url().rstrip("/")
    key = supabase_anon_key()
    if not url_base or not key:
        raise RuntimeError(
            "Supabase not configured. Set BEANTHENTIC_SUPABASE_URL and "
            "BEANTHENTIC_SUPABASE_ANON_KEY in .env."
        )

    params: dict[str, str] = {"select": select}
    if order:
        params["order"] = order
    if limit is not None:
        params["limit"] = str(max(1, int(limit)))
    for col, expr in (filters or {}).items():
        params[col] = expr

    endpoint = f"{url_base}/rest/v1/{table}?{urlencode(params)}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }

    last_err: BaseException | None = None
    ssl_ctx = beanthentic_env.https_ssl_context()
    for attempt in range(3):
        try:
            req = Request(endpoint, headers=headers, method="GET")
            with urlopen(req, timeout=timeout, context=ssl_ctx) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw) if raw else []
            if isinstance(data, list):
                return [row for row in data if isinstance(row, dict)]
            return []
        except HTTPError as exc:
            try:
                body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                body = ""
            raise RuntimeError(f"Supabase REST HTTP {exc.code}: {body or exc.reason}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            last_err = exc
            if is_transient_socket_error(exc) and attempt < 2:
                time.sleep(0.35 * (attempt + 1))
                continue
            reason = getattr(exc, "reason", exc)
            raise RuntimeError(f"Supabase REST request failed: {reason}") from exc
        except Exception as exc:
            last_err = exc
            if is_transient_socket_error(exc) and attempt < 2:
                time.sleep(0.35 * (attempt + 1))
                continue
            raise
    if last_err:
        raise RuntimeError(f"Supabase REST request failed: {last_err}") from last_err
    return []


def verify_connection() -> tuple[bool, str]:
    """Probe Supabase REST API with the anon key."""
    if not is_configured():
        return False, "BEANTHENTIC_SUPABASE_URL and BEANTHENTIC_SUPABASE_ANON_KEY required in .env"
    try:
        client = get_client()
        client.table("farmers").select("farmer_id").limit(1).execute()
        return True, "OK"
    except Exception as exc:
        text = str(exc).lower()
        if "invalid api key" in text or "jwt" in text:
            return False, "Invalid Supabase anon key — check BEANTHENTIC_SUPABASE_ANON_KEY in .env"
        if "relation" in text and "does not exist" in text:
            return False, "Supabase connected but farmers table is missing — run schema migration"
        return False, str(exc)


def table(name: str):
    return get_client().table(name)
