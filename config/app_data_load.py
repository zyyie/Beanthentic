"""
Load Beanthentic-App data via MySQL or HTTP bridge (:8080).

When the admin PC cannot reach XAMPP MySQL on port 3306 (common on Wi‑Fi/LAN),
but can reach app_server_base, try HTTP first to avoid long connect timeouts.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from config.app_connection import friendly_load_failure, prefer_app_http_bridge

T = TypeVar("T")


def load_with_app_bridge(
    *,
    module_label: str,
    mysql_loader: Callable[[], T],
    http_loader: Callable[[], T],
) -> tuple[T, str]:
    """
    Returns (data, source) where source is 'app_mysql' or 'app_server_http'.
    """
    mysql_err: Exception | None = None
    http_err: Exception | None = None

    if prefer_app_http_bridge():
        try:
            return http_loader(), "app_server_http"
        except Exception as exc:
            http_err = exc
        try:
            return mysql_loader(), "app_mysql"
        except Exception as exc:
            mysql_err = exc
    else:
        try:
            return mysql_loader(), "app_mysql"
        except Exception as exc:
            mysql_err = exc
        try:
            return http_loader(), "app_server_http"
        except Exception as exc:
            http_err = exc

    raise RuntimeError(
        friendly_load_failure(
            module_label=module_label,
            mysql_error=mysql_err,
            http_error=http_err,
        )
    )
