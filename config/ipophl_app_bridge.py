"""
HTTP bridge for IPOPHL document_analysis on the Beanthentic-App (XAMPP) server.
Used when the admin PC cannot reach MySQL on port 3306 but can reach app_server_base :8080.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from config.app_connection import (
    app_db_params,
    app_http_timeout,
    app_server_base,
    friendly_load_failure,
    iter_app_server_bases,
)


def app_shared_configured() -> bool:
    return bool(app_db_params()) or bool(app_server_base())


def _bridge_url(action: str, query: dict | None = None, *, base: str | None = None) -> str:
    resolved = (base or app_server_base() or "").strip().rstrip("/")
    if not resolved:
        raise RuntimeError("APP_SERVER_BASE_NOT_SET")
    q = {"action": action, **(query or {})}
    qs = urlencode({k: v for k, v in q.items() if v is not None and v != ""})
    return f"{resolved}/api/admin_ipophl_documents.php?{qs}"


def _parse_bridge_response(raw: str) -> dict:
    data = json.loads(raw) if raw else {}
    if not isinstance(data, dict) or data.get("ok") is not True:
        err = (data or {}).get("error") if isinstance(data, dict) else None
        raise RuntimeError(err or "BAD_RESPONSE_FROM_APP_SERVER")
    return data


def _request_bridge(
    *,
    action: str,
    query: dict | None = None,
    body: dict | None = None,
    timeout: float | None = None,
) -> dict:
    if timeout is None:
        timeout = app_http_timeout()
    bases = iter_app_server_bases()
    if not bases:
        raise RuntimeError("APP_SERVER_BASE_NOT_SET")

    last_err: BaseException | None = None
    for base in bases:
        try:
            if body is not None:
                url = _bridge_url("upsert", base=base)
                payload = json.dumps(body).encode("utf-8")
                req = Request(
                    url,
                    data=payload,
                    method="POST",
                    headers={"Accept": "application/json", "Content-Type": "application/json"},
                )
            else:
                url = _bridge_url(action, query, base=base)
                req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            return _parse_bridge_response(raw)
        except HTTPError as e:
            try:
                err_body = e.read().decode("utf-8", errors="replace")
                parsed = json.loads(err_body) if err_body else {}
                if isinstance(parsed, dict) and parsed.get("error"):
                    last_err = RuntimeError(str(parsed.get("error")))
                    continue
            except (ValueError, json.JSONDecodeError):
                pass
            last_err = RuntimeError(f"HTTP {e.code} at {base}")
        except (URLError, TimeoutError) as e:
            last_err = RuntimeError(str(e))
        except Exception as e:
            last_err = e
    if last_err:
        raise last_err
    raise RuntimeError("Could not reach app server")


def upsert_payload_from_model(doc) -> dict:
    """Build JSON body for admin_ipophl_documents.php upsert."""
    upload_ts = doc.upload_timestamp
    if isinstance(upload_ts, datetime):
        upload_ts = upload_ts.isoformat()
    analysis_ts = doc.analysis_timestamp
    if isinstance(analysis_ts, datetime):
        analysis_ts = analysis_ts.isoformat()
    score_breakdown = getattr(doc, "score_breakdown", None)
    if not isinstance(score_breakdown, dict):
        score_breakdown = None
    ip_pillar_assessment = getattr(doc, "ip_pillar_assessment", None)
    if not isinstance(ip_pillar_assessment, dict):
        ip_pillar_assessment = None
    return {
        "file_uuid": doc.file_uuid,
        "original_filename": doc.original_filename,
        "file_path": doc.file_path,
        "file_type": doc.file_type,
        "file_size": int(doc.file_size or 0),
        "ai_score": int(doc.ai_score or 0),
        "ai_status": doc.ai_status or "Not Ready",
        "detected_features": doc.detected_features_list,
        "missing_requirements": doc.missing_requirements_list,
        "analysis_method": doc.analysis_method or "rule_based",
        "text_length": int(doc.text_length or 0),
        "shap_analysis": doc.shap_analysis or "",
        "score_breakdown": score_breakdown,
        "ip_pillar_assessment": ip_pillar_assessment,
        "upload_timestamp": upload_ts or "",
        "analysis_timestamp": analysis_ts or datetime.utcnow().isoformat(),
        "ipophl_phase": doc.ipophl_phase or "",
        "task_id": doc.task_id or "",
    }


def upsert_payload_from_fields(**fields: Any) -> dict:
    detected = fields.get("detected_features", [])
    missing = fields.get("missing_requirements", [])
    if not isinstance(detected, list):
        detected = []
    if not isinstance(missing, list):
        missing = []
    analysis_ts = fields.get("analysis_timestamp")
    if isinstance(analysis_ts, datetime):
        analysis_ts = analysis_ts.isoformat()
    upload_ts = fields.get("upload_timestamp")
    if isinstance(upload_ts, datetime):
        upload_ts = upload_ts.isoformat()
    score_breakdown = fields.get("score_breakdown")
    if not isinstance(score_breakdown, dict):
        score_breakdown = None
    ip_pillar_assessment = fields.get("ip_pillar_assessment")
    if not isinstance(ip_pillar_assessment, dict):
        ip_pillar_assessment = None
    return {
        "file_uuid": fields["file_uuid"],
        "original_filename": fields.get("original_filename", "document"),
        "file_path": fields.get("file_path", ""),
        "file_type": fields.get("file_type", ""),
        "file_size": int(fields.get("file_size") or 0),
        "ai_score": int(fields.get("ai_score") or 0),
        "ai_status": fields.get("ai_status") or "Not Ready",
        "detected_features": detected,
        "missing_requirements": missing,
        "analysis_method": fields.get("analysis_method") or "rule_based",
        "text_length": int(fields.get("text_length") or 0),
        "shap_analysis": fields.get("shap_analysis") or "",
        "score_breakdown": score_breakdown,
        "ip_pillar_assessment": ip_pillar_assessment,
        "upload_timestamp": upload_ts or datetime.utcnow().isoformat(),
        "analysis_timestamp": analysis_ts or datetime.utcnow().isoformat(),
        "ipophl_phase": fields.get("ipophl_phase") or "",
        "task_id": fields.get("task_id") or "",
    }


def http_list_documents(
    *, phase: str | None, task_id: str | None, limit: int, timeout: float | None = None
) -> list[dict]:
    query: dict[str, Any] = {"limit": limit}
    if phase:
        query["phase"] = phase
    if task_id:
        query["task_id"] = task_id
    data = _request_bridge(action="list", query=query, timeout=timeout)
    items = data.get("items")
    return items if isinstance(items, list) else []


def http_get_document(file_uuid: str, *, timeout: float | None = None) -> dict:
    data = _request_bridge(action="get", query={"file_uuid": file_uuid}, timeout=timeout)
    doc = data.get("document")
    if not isinstance(doc, dict):
        raise RuntimeError("MISSING_DOCUMENT")
    return doc


def http_upsert_document(payload: dict, *, timeout: float | None = None) -> None:
    _request_bridge(action="upsert", body=payload, timeout=timeout)


def http_delete_document(file_uuid: str) -> None:
    _request_bridge(action="delete", query={"file_uuid": file_uuid})


def ipophl_load_failure(
    *,
    mysql_error: BaseException | None,
    http_error: BaseException | None,
) -> str:
    return friendly_load_failure(
        module_label="IPOPHL documents",
        mysql_error=mysql_error,
        http_error=http_error,
    )
