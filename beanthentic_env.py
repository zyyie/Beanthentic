"""
Load .env and resolve Supabase settings for Beanthentic Admin, App, and Client.

Primary connection (all three apps):
  - BEANTHENTIC_SUPABASE_URL  (https://YOUR_REF.supabase.co)
  - BEANTHENTIC_SUPABASE_ANON_KEY  (publishable / anon key from Dashboard → API)

Optional server-side SQL (admin SQLAlchemy / complex queries, same Supabase project):
  - BEANTHENTIC_DB_URL or BEANTHENTIC_DB_TYPE=postgresql + host/user/pass
  - BEANTHENTIC_SUPABASE_PROJECT_REF (pooler username fix)

LAN app-server / MySQL bridges are not used when Supabase anon is configured.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import quote, unquote, urlparse, urlunparse

_BASE_DIR = Path(__file__).resolve().parent


def load_dotenv(path: Path | str | None = None) -> None:
    """Load KEY=VALUE lines into os.environ (does not override existing vars)."""
    candidates = []
    if path:
        candidates.append(Path(path))
    else:
        candidates.append(_BASE_DIR / ".env")
        candidates.append(_BASE_DIR / "sms-gate.env")

    for file_path in candidates:
        if not file_path.is_file():
            continue
        try:
            for raw in file_path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
        except OSError:
            continue


def _settings_root() -> dict:
    try:
        raw = json.loads((_BASE_DIR / "settings.json").read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except OSError:
        return {}


def _settings_connection() -> dict:
    conn = _settings_root().get("connection")
    return conn if isinstance(conn, dict) else {}


def supabase_project_ref() -> str:
    ref = (os.environ.get("BEANTHENTIC_SUPABASE_PROJECT_REF") or "").strip()
    if ref:
        return ref
    url = supabase_url()
    if url:
        try:
            host = urlparse(url).hostname or ""
            if host.endswith(".supabase.co"):
                return host.split(".")[0]
        except Exception:
            pass
    user = (os.environ.get("BEANTHENTIC_DB_USER") or "").strip()
    if user.startswith("postgres.") and len(user) > len("postgres."):
        return user.split(".", 1)[1]
    conn_ref = str(_settings_connection().get("supabase_project_ref") or "").strip()
    return conn_ref


def supabase_url() -> str:
    url = (
        os.environ.get("BEANTHENTIC_SUPABASE_URL")
        or os.environ.get("SUPABASE_URL")
        or ""
    ).strip().rstrip("/")
    if url:
        return url
    ref = supabase_project_ref()
    if ref:
        return f"https://{ref}.supabase.co"
    return str(_settings_connection().get("supabase_url") or "").strip().rstrip("/")


def supabase_anon_key() -> str:
    key = (
        os.environ.get("BEANTHENTIC_SUPABASE_ANON_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
        or ""
    ).strip()
    if key:
        return key
    return str(_settings_connection().get("supabase_anon_key") or "").strip()


def uses_supabase_anon() -> bool:
    return bool(supabase_url() and supabase_anon_key())


def _supabase_project_ref() -> str:
    return supabase_project_ref()


def _build_postgres_url_from_env() -> str:
    host = (os.environ.get("BEANTHENTIC_DB_HOST") or "").strip()
    if not host:
        return ""
    port = int((os.environ.get("BEANTHENTIC_DB_PORT") or "5432").strip() or "5432")
    user = (os.environ.get("BEANTHENTIC_DB_USER") or "postgres").strip()
    password = os.environ.get("BEANTHENTIC_DB_PASS")
    if password is None:
        password = ""
    database = (os.environ.get("BEANTHENTIC_DB_NAME") or "postgres").strip()
    if "pooler.supabase.com" in host and user == "postgres":
        ref = _supabase_project_ref()
        if ref:
            user = f"postgres.{ref}"
    user_q = quote(user, safe="")
    pass_q = quote(password, safe="")
    return f"postgresql://{user_q}:{pass_q}@{host}:{port}/{database}"


def _normalize_supabase_url(url: str) -> str:
    if not url:
        return url
    raw = url.strip()
    if raw.lower().startswith("postgres://"):
        raw = "postgresql://" + raw[len("postgres://") :]

    parsed = urlparse(raw)
    host = parsed.hostname or ""
    user = unquote(parsed.username or "")
    password = unquote(parsed.password or "")

    if "pooler.supabase.com" in host and user == "postgres":
        ref = _supabase_project_ref()
        if ref:
            user = f"postgres.{ref}"
            user_q = quote(user, safe="")
            pass_q = quote(password, safe="")
            port = parsed.port or 5432
            db = (parsed.path or "/postgres").lstrip("/") or "postgres"
            netloc = f"{user_q}:{pass_q}@{host}:{port}"
            raw = urlunparse(("postgresql", netloc, f"/{db}", "", parsed.query, ""))

    return raw


def _settings_connection_url() -> str:
    return str(_settings_connection().get("app_db_url") or "").strip()


def get_db_url() -> str:
    url = (os.environ.get("BEANTHENTIC_DB_URL") or os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        db_type = (os.environ.get("BEANTHENTIC_DB_TYPE") or "").strip().lower()
        if db_type in ("postgresql", "postgres"):
            url = _build_postgres_url_from_env()
    if not url:
        url = _settings_connection_url()
    if url:
        return _normalize_supabase_url(url)
    return ""


def is_postgresql() -> bool:
    if uses_supabase_anon():
        return True
    url = get_db_url().lower()
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        return True
    return (os.environ.get("BEANTHENTIC_DB_TYPE") or "").strip().lower() in ("postgresql", "postgres")


def is_mysql() -> bool:
    if uses_supabase_anon() or is_postgresql():
        return False
    url = get_db_url().lower()
    if url.startswith("mysql://") or url.startswith("mysql+pymysql://"):
        return True
    return bool(os.environ.get("BEANTHENTIC_DB_HOST", "").strip())


def _params_from_url(url: str) -> dict:
    raw = url.strip()
    if "://" not in raw:
        raw = f"mysql://{raw}"
    parsed = urlparse(raw)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (5432 if parsed.scheme.startswith("postgres") else 3306)
    user = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
    database = (parsed.path or "").lstrip("/") or "postgres"
    return {
        "host": host,
        "port": int(port),
        "user": user,
        "password": password,
        "database": database,
    }


def mysql_params() -> dict:
    url = get_db_url()
    if url and not is_postgresql():
        p = _params_from_url(url)
    else:
        p = {
            "host": os.environ.get("BEANTHENTIC_DB_HOST", "127.0.0.1"),
            "port": int(os.environ.get("BEANTHENTIC_DB_PORT", "3306")),
            "user": os.environ.get("BEANTHENTIC_DB_USER", "root"),
            "password": os.environ.get("BEANTHENTIC_DB_PASS", ""),
            "database": os.environ.get("BEANTHENTIC_DB_NAME", "beanthentic_app"),
        }
    return {
        "host": p["host"],
        "port": int(p["port"]),
        "user": p["user"],
        "password": p["password"],
        "database": p["database"],
        "charset": "utf8mb4",
        "autocommit": False,
        "connect_timeout": 15,
        "read_timeout": 30,
        "write_timeout": 30,
    }


def sqlalchemy_database_url() -> str:
    url = get_db_url()
    if url:
        low = url.lower()
        if low.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://") :]
        if low.startswith("postgresql://") and "+psycopg2" not in low and "+psycopg" not in low:
            # Prefer psycopg (v3) if available, fall back to psycopg2
            try:
                import psycopg
                url = url.replace("postgresql://", "postgresql+psycopg://", 1)
            except ImportError:
                url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
        return url
    if uses_supabase_anon():
        raise RuntimeError(
            "Supabase anon key is set but no BEANTHENTIC_DB_URL for admin SQLAlchemy. "
            "Add the Supabase pooler URI to .env for server-side admin tables, "
            "or use REST-only routes."
        )
    p = mysql_params()
    user = quote(p["user"], safe="")
    password = quote(p["password"], safe="")
    return f"mysql+pymysql://{user}:{password}@{p['host']}:{p['port']}/{p['database']}"


def _postgres_connect_url(host: str | None = None, port: int | None = None) -> str:
    url = get_db_url()
    if not url:
        url = _build_postgres_url_from_env()
    if not url:
        return ""
    if url.lower().startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]

    if host:
        parsed = urlparse(url)
        user = unquote(parsed.username or "")
        password = unquote(parsed.password or "")
        db = (parsed.path or "/postgres").lstrip("/") or "postgres"
        use_port = int(port or parsed.port or 5432)
        user_q = quote(user, safe="")
        pass_q = quote(password, safe="")
        netloc = f"{user_q}:{pass_q}@{host}:{use_port}"
        url = urlunparse(("postgresql", netloc, f"/{db}", "", parsed.query, ""))

    sslmode = os.environ.get("BEANTHENTIC_DB_SSLMODE", "require").strip() or "require"
    if "sslmode=" not in url.lower():
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}sslmode={sslmode}"
    return url


def _postgres_urls_to_try() -> list[str]:
    primary = _postgres_connect_url()
    urls: list[str] = []
    if primary:
        urls.append(primary)

    ref = supabase_project_ref()
    if not ref or not primary:
        return urls

    parsed = urlparse(primary)
    host = parsed.hostname or ""
    if host.startswith("db.") and host.endswith(".supabase.co"):
        return urls

    direct_host = f"db.{ref}.supabase.co"
    if direct_host != host:
        direct = _postgres_connect_url(host=direct_host, port=5432)
        if direct and direct not in urls:
            urls.append(direct)
    return urls


def _connect_postgresql():
    import time

    from config.app_connection import is_transient_socket_error

    last_err: Exception | None = None
    urls = _postgres_urls_to_try()

    for url in urls:
        for attempt in range(3):
            try:
                import psycopg2
                from psycopg2.extras import RealDictCursor

                conn = psycopg2.connect(url, cursor_factory=RealDictCursor)
                conn.autocommit = False
                return conn
            except ImportError as exc:
                last_err = exc
                break
            except Exception as exc:
                last_err = exc
                err_text = str(exc).lower()
                if "enoidentifier" in err_text or "tenant identifier" in err_text:
                    raise RuntimeError(
                        "Supabase pooler needs BEANTHENTIC_SUPABASE_PROJECT_REF in .env "
                        "(Dashboard → Settings → General → Reference ID)"
                    ) from exc
                if is_transient_socket_error(exc) and attempt < 2:
                    time.sleep(0.35 * (attempt + 1))
                    continue
                if len(urls) > 1:
                    break
                if "circuitbreaker" in err_text or "authentication failed" in err_text:
                    raise RuntimeError(
                        "Supabase PostgreSQL login failed. After unpausing your project, reset the "
                        "database password in Supabase Dashboard → Project Settings → Database, then "
                        "update BEANTHENTIC_DB_PASS in .env and restart web.py."
                    ) from exc
                raise

    try:
        import psycopg
        from psycopg.rows import dict_row

        for url in _postgres_urls_to_try():
            try:
                conn = psycopg.connect(url, row_factory=dict_row)
                conn.autocommit = False
                return conn
            except Exception as exc:
                last_err = exc
                if len(_postgres_urls_to_try()) > 1:
                    continue
                raise
    except ImportError as exc:
        raise RuntimeError(
            "PostgreSQL driver missing. Run: pip install -r requirements.txt"
        ) from (last_err or exc)

    if last_err:
        err_text = str(last_err).lower()
        if "circuitbreaker" in err_text or "authentication failed" in err_text:
            raise RuntimeError(
                "Supabase PostgreSQL login failed. After unpausing your project, reset the "
                "database password in Supabase Dashboard → Project Settings → Database, then "
                "update BEANTHENTIC_DB_PASS in .env and restart web.py."
            ) from last_err
        raise last_err
    raise RuntimeError("PostgreSQL is configured but BEANTHENTIC_DB_URL/BEANTHENTIC_DB_HOST is missing.")


def connect():
    """
    Server-side PostgreSQL connection for SQL-heavy admin routes.
    Requires BEANTHENTIC_DB_URL (Supabase pooler). App/client use anon REST instead.
    """
    if is_postgresql():
        if not get_db_url():
            raise RuntimeError(
                "BEANTHENTIC_DB_URL required for server SQL. "
                "App/client should use BEANTHENTIC_SUPABASE_ANON_KEY via REST."
            )
        return _connect_postgresql()

    import pymysql
    from pymysql.cursors import DictCursor

    params = mysql_params()
    params["cursorclass"] = DictCursor
    return pymysql.connect(**params)


def verify_connection() -> tuple[bool, str]:
    """Probe Supabase via anon REST API first, then optional server SQL."""
    if uses_supabase_anon():
        from config.supabase_client import verify_connection as verify_anon

        rest_ok, rest_msg = verify_anon()
        if not rest_ok:
            return False, rest_msg

        if not get_db_url():
            return True, "OK (REST only — server SQL not configured)"

        try:
            conn = connect()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1 AS ok")
                    cur.fetchone()
            finally:
                conn.close()
            return True, "OK (REST + PostgreSQL)"
        except Exception as exc:
            return True, f"OK (REST only — PostgreSQL unavailable: {exc})"

    try:
        conn = connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok")
                cur.fetchone()
        finally:
            conn.close()
        return True, "OK"
    except Exception as exc:
        return False, str(exc)


def sync_settings_connection(settings_path: Path | str | None = None) -> list[str]:
    """Push Supabase anon config into settings.json for App and Client."""
    path = Path(settings_path) if settings_path else _BASE_DIR / "settings.json"
    notes: list[str] = []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        raw = {}
    if not isinstance(raw, dict):
        raw = {}

    conn: dict = {}
    changed = False

    url = supabase_url()
    if url and conn.get("supabase_url") != url:
        conn["supabase_url"] = url
        notes.append("Synced connection.supabase_url from environment")
        changed = True

    anon = supabase_anon_key()
    if anon and conn.get("supabase_anon_key") != anon:
        conn["supabase_anon_key"] = anon
        notes.append("Synced connection.supabase_anon_key from environment")
        changed = True

    ref = supabase_project_ref()
    if ref and conn.get("supabase_project_ref") != ref:
        conn["supabase_project_ref"] = ref
        changed = True

    if changed:
        raw["connection"] = conn
        path.write_text(json.dumps(raw, indent=2), encoding="utf-8")

    return notes


def supabase_service_role_key() -> str:
    return os.environ.get("BEANTHENTIC_SUPABASE_SERVICE_ROLE_KEY", "").strip()


def supabase_storage_bucket() -> str:
    return os.environ.get("BEANTHENTIC_SUPABASE_STORAGE_BUCKET", "profile-photos").strip() or "profile-photos"


def admin_public_base() -> str:
    """LAN/HTTPS base of the admin Flask app (port 5000) for GI file links."""
    base = os.environ.get("BEANTHENTIC_ADMIN_PUBLIC_BASE", "").strip().rstrip("/")
    if base:
        return base
    return str(_settings_root().get("sms", {}).get("public_base_url") or "").strip().rstrip("/")


def _supabase_storage_upload_rest(
    project_url: str,
    service_key: str,
    bucket: str,
    object_name: str,
    file_bytes: bytes,
    content_type: str,
) -> bool:
    """Upload via Storage REST API (works with sb_secret_* and JWT service_role keys)."""
    import urllib.error
    import urllib.request

    endpoint = (
        f"{project_url.rstrip('/')}/storage/v1/object/{bucket}/{object_name.lstrip('/')}"
    )
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": content_type or "application/octet-stream",
        "x-upsert": "true",
    }
    for method in ("POST", "PUT"):
        try:
            req = urllib.request.Request(endpoint, data=file_bytes, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=90) as resp:
                if 200 <= int(resp.status) < 300:
                    return True
        except urllib.error.HTTPError as exc:
            if exc.code in (409, 400) and method == "POST":
                continue
            if exc.code == 405 and method == "POST":
                continue
        except Exception:
            continue
    return False


def download_from_supabase_storage(object_name: str) -> tuple[bytes, str] | None:
    """Download one object from Supabase Storage using the service role key."""
    import mimetypes
    import urllib.error
    import urllib.request

    project_url = supabase_url()
    key = supabase_service_role_key()
    bucket = supabase_storage_bucket()
    safe_name = (object_name or "").strip().lstrip("/")
    if not project_url or not key or not bucket or not safe_name:
        return None
    mime = mimetypes.guess_type(safe_name)[0] or "image/jpeg"
    auth_headers = {"Authorization": f"Bearer {key}", "apikey": key}
    endpoints = [
        f"{project_url.rstrip('/')}/storage/v1/object/{bucket}/{safe_name}",
        f"{project_url.rstrip('/')}/storage/v1/object/public/{bucket}/{safe_name}",
    ]
    for endpoint in endpoints:
        try:
            req = urllib.request.Request(endpoint, headers=auth_headers, method="GET")
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                if body and len(body) > 32:
                    ctype = (resp.headers.get("Content-Type") or mime).split(";")[0].strip()
                    if ctype.startswith("image/"):
                        return body, ctype
        except urllib.error.HTTPError:
            continue
        except Exception:
            continue
    return None


def upload_to_supabase_storage(
    file_bytes: bytes, file_name: str, content_type: str = "image/jpeg"
) -> str | None:
    """Upload bytes to Supabase Storage; returns stable public URL."""
    url = supabase_url()
    key = supabase_service_role_key()
    bucket = supabase_storage_bucket()
    if not url or not key or not bucket or not file_bytes:
        return None
    safe_name = (file_name or "").strip().lstrip("/")
    if not safe_name:
        return None
    public_url = f"{url.rstrip('/')}/storage/v1/object/public/{bucket}/{safe_name}"
    if _supabase_storage_upload_rest(url, key, bucket, safe_name, file_bytes, content_type):
        return public_url
    try:
        from supabase import create_client

        client = create_client(url, key)
        client.storage.from_(bucket).upload(
            safe_name,
            file_bytes,
            {"contentType": content_type, "upsert": True},
        )
        return public_url
    except Exception:
        return None


# Load on import
load_dotenv()
try:
    for _note in sync_settings_connection():
        print(f"[Beanthentic] {_note}")
except Exception:
    pass
