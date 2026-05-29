"""
PyMySQL connection to Beanthentic-App MySQL on the LAN (XAMPP device).

Typical setup (3 devices):
  - Device A: mobile app + XAMPP (MySQL host — set app_db_host to A's LAN IP on B and C)
  - Device B: Beanthentic admin web
  - Device C: Beanthentic-Client-Web

Admin/Client must NOT use 127.0.0.1 unless Flask runs on the same PC as XAMPP.
One-time server setup: Beanthentic-App/xampp-enable-lan-mysql.sql (run in phpMyAdmin on device A).
"""

from __future__ import annotations

import os

import pymysql
from pymysql.err import OperationalError


def _is_loopback(h: str) -> bool:
    x = (h or "").strip().lower()
    return x in ("127.0.0.1", "localhost", "::1")


def connect_app_mysql(params: dict) -> pymysql.connections.Connection:
    """
    Connect to the configured remote host (no local hostname grants, no admin-side SQL).

    Optional: BEANTHENTIC_APP_DB_FAILOVER_LOCALHOST=1 retries 127.0.0.1 only on error 2003
    (can't reach server) — for dev when Flask and XAMPP share one PC.
    """
    timeout_raw = os.getenv("BEANTHENTIC_APP_DB_CONNECT_TIMEOUT", "10").strip()
    try:
        connect_timeout = max(2, min(60, int(timeout_raw)))
    except ValueError:
        connect_timeout = 10

    host = str(params.get("host") or "").strip()
    if not host:
        raise OperationalError(2003, "app_db_host is empty — set the XAMPP device LAN IP in settings.json")

    base = {**params, "host": host, "connect_timeout": connect_timeout}

    # Off by default — localhost retry causes misleading "Access denied for root@localhost"
    # when the real issue is an unreachable LAN host. Set BEANTHENTIC_APP_DB_FAILOVER_LOCALHOST=1 to enable.
    failover_raw = os.getenv("BEANTHENTIC_APP_DB_FAILOVER_LOCALHOST", "0").strip().lower()
    failover = failover_raw in ("1", "true", "yes", "on")

    try:
        return pymysql.connect(**base)
    except OperationalError as e:
        errno = e.args[0] if e.args else None
        if failover and errno == 2003 and not _is_loopback(host):
            return pymysql.connect(**{**base, "host": "127.0.0.1"})
        raise
