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

from config.app_connection import is_loopback_host, lan_mysql_fallback_hosts, app_db_connect_timeout


def _is_loopback(h: str) -> bool:
    return is_loopback_host(h)


def connect_app_mysql(params: dict) -> pymysql.connections.Connection:
    """
    Connect to the configured remote host (no local hostname grants, no admin-side SQL).

    Optional: BEANTHENTIC_APP_DB_FAILOVER_LOCALHOST=1 retries 127.0.0.1 only on error 2003
    (can't reach server) — for dev when Flask and XAMPP share one PC.
    """
    connect_timeout = app_db_connect_timeout(8)
    fallback_timeout = min(5, connect_timeout)

    host = str(params.get("host") or "").strip()
    if not host:
        raise OperationalError(2003, "app_db_host is empty — set the XAMPP device LAN IP in settings.json")

    base = {**params, "connect_timeout": connect_timeout}

    # Off by default — localhost retry causes misleading "Access denied for root@localhost"
    # when the real issue is an unreachable LAN host. Set BEANTHENTIC_APP_DB_FAILOVER_LOCALHOST=1 to enable.
    failover_raw = os.getenv("BEANTHENTIC_APP_DB_FAILOVER_LOCALHOST", "0").strip().lower()
    failover = failover_raw in ("1", "true", "yes", "on")

    hosts_to_try = [host]
    if _is_loopback(host):
        for alt in lan_mysql_fallback_hosts():
            if alt not in hosts_to_try:
                hosts_to_try.append(alt)
    elif failover:
        hosts_to_try.append("127.0.0.1")

    last_err: OperationalError | None = None
    for index, try_host in enumerate(hosts_to_try):
        timeout = connect_timeout if index == 0 else fallback_timeout
        try:
            return pymysql.connect(**{**base, "host": try_host, "connect_timeout": timeout})
        except OperationalError as e:
            last_err = e
            errno = e.args[0] if e.args else None
            # Wrong password / unknown DB — same on every host; stop early.
            if errno in (1045, 1049, 1044):
                raise
            # 2003/2002: unreachable; 1130: host not allowed — try next candidate.
            if try_host != hosts_to_try[-1] and errno in (2003, 2002, 1130):
                continue
            # Non-loopback configured host: optional localhost retry (dev).
            if not _is_loopback(host) and errno in (2003, 2002, 1130):
                if failover or errno == 1130:
                    try:
                        return pymysql.connect(**{**base, "host": "127.0.0.1"})
                    except OperationalError:
                        pass
            raise
    if last_err:
        raise last_err
    raise OperationalError(2003, "Could not connect to app MySQL")
