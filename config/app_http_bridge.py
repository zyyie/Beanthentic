"""
HTTP helpers for Beanthentic admin → Beanthentic-App (LAN :8080).

Used when direct MySQL (port 3306) is blocked but app_server_base is reachable.
"""

from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from config.app_connection import app_http_timeout, iter_app_server_bases


def _urlopen_with_retry(req: Request, *, timeout: float) -> str:
    """One automatic retry on Wi‑Fi timeout."""
    last_err: BaseException | None = None
    for attempt in range(2):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except URLError as exc:
            last_err = exc
            reason = str(getattr(exc, "reason", exc)).lower()
            if attempt == 0 and ("timed out" in reason or "timeout" in reason):
                continue
            raise
    if last_err:
        raise last_err
    return ""


def _app_http_request_json(
    method: str,
    path: str,
    *,
    body: dict | None = None,
    query: dict | None = None,
    timeout: float | None = None,
    extra_headers: dict | None = None,
) -> dict:
    if timeout is None:
        timeout = app_http_timeout()
    bases = iter_app_server_bases()
    if not bases:
        raise RuntimeError("app_server_base not set in settings.json")
    path = path if path.startswith("/") else f"/{path}"
    last_err: BaseException | None = None
    for base in bases:
        url = base + path
        if query:
            url = f"{url}?{urlencode({k: v for k, v in query.items() if v is not None and v != ''})}"
        headers = {"Accept": "application/json", **(extra_headers or {})}
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
            req = Request(url, data=payload, headers=headers, method=method)
        else:
            req = Request(url, headers=headers, method=method)
        try:
            raw = _urlopen_with_retry(req, timeout=timeout)
            data = json.loads(raw) if raw else {}
            return data if isinstance(data, dict) else {}
        except HTTPError as exc:
            try:
                raw = exc.read().decode("utf-8", errors="replace")
                parsed = json.loads(raw) if raw else {}
                if isinstance(parsed, dict) and (parsed.get("error") or parsed.get("detail")):
                    raise RuntimeError(str(parsed.get("detail") or parsed.get("error"))) from exc
            except RuntimeError:
                raise
            except Exception:
                pass
            last_err = RuntimeError(f"App server returned HTTP {exc.code} at {base}")
        except URLError as exc:
            last_err = RuntimeError(f"Cannot reach app server at {base}: {exc.reason}")
        except Exception as exc:
            last_err = exc
    if last_err:
        raise last_err
    raise RuntimeError("Could not reach app server")


def app_http_get_json(
    path: str,
    *,
    query: dict | None = None,
    timeout: float | None = None,
) -> dict:
    return _app_http_request_json("GET", path, query=query, timeout=timeout)


def app_http_post_json(
    path: str,
    body: dict,
    *,
    timeout: float | None = None,
) -> dict:
    return _app_http_request_json("POST", path, body=body, timeout=timeout)


def app_http_delete_json(
    path: str,
    *,
    query: dict | None = None,
    timeout: float | None = None,
) -> dict:
    return _app_http_request_json(
        "POST",
        path,
        query=query,
        timeout=timeout,
        extra_headers={"X-HTTP-Method-Override": "DELETE"},
    )


def app_http_patch_json(
    path: str,
    body: dict,
    *,
    timeout: float | None = None,
) -> dict:
    """PATCH via POST + X-HTTP-Method-Override for PHP built-in server compatibility."""
    return _app_http_request_json(
        "POST",
        path,
        body=body,
        timeout=timeout,
        extra_headers={"X-HTTP-Method-Override": "PATCH"},
    )


def app_http_post_multipart(
    path: str,
    fields: dict[str, str],
    files: list[tuple[str, str, bytes, str | None]],
    *,
    timeout: float | None = None,
) -> dict:
    """POST multipart/form-data to the app server (GI broadcast with attachments)."""
    import uuid
    from io import BytesIO

    if timeout is None:
        timeout = app_http_timeout()
    bases = iter_app_server_bases()
    if not bases:
        raise RuntimeError("app_server_base not set in settings.json")

    boundary = f"----Beanthentic{uuid.uuid4().hex}"
    body = BytesIO()
    for key, value in fields.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        body.write(f"{value}\r\n".encode())
    for field_name, filename, content, content_type in files:
        body.write(f"--{boundary}\r\n".encode())
        body.write(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode()
        )
        body.write(f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n".encode())
        body.write(content)
        body.write(b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())
    payload = body.getvalue()

    path = path if path.startswith("/") else f"/{path}"
    last_err: BaseException | None = None
    for base in bases:
        url = base.rstrip("/") + path
        req = Request(
            url,
            data=payload,
            headers={
                "Accept": "application/json",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            method="POST",
        )
        try:
            raw = _urlopen_with_retry(req, timeout=timeout)
            data = json.loads(raw) if raw else {}
            return data if isinstance(data, dict) else {}
        except HTTPError as exc:
            try:
                raw = exc.read().decode("utf-8", errors="replace")
                parsed = json.loads(raw) if raw else {}
                if isinstance(parsed, dict) and (parsed.get("error") or parsed.get("detail")):
                    raise RuntimeError(str(parsed.get("detail") or parsed.get("error"))) from exc
            except RuntimeError:
                raise
            except Exception:
                pass
            last_err = RuntimeError(f"App server returned HTTP {exc.code} at {base}")
        except URLError as exc:
            last_err = RuntimeError(f"Cannot reach app server at {base}: {exc.reason}")
        except Exception as exc:
            last_err = exc
    if last_err:
        raise last_err
    raise RuntimeError("Could not reach app server")
