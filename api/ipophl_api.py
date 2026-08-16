"""
IPOPHL document analysis API endpoints for Beanthentic application.

Provides endpoints for IPOPHL document upload, analysis, and retrieval.
When connected to the app DB, uses SQLAlchemy first and HTTP bridge fallback
(same pattern as farmer records and messages).
"""

import io
import json
import os
import threading
import urllib.parse
import zipfile
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from flask import jsonify, request, send_file
from werkzeug.utils import secure_filename

from config.app_connection import app_db_params, app_server_base
from config.ipophl_app_bridge import (
    http_delete_document,
    http_get_document,
    http_list_documents,
    http_upsert_document,
    upsert_payload_from_model,
)
from config.ipophl_store import (
    analysis_payload_from_record,
    apply_task_overrides_to_store,
    bootstrap_orphan_uploads,
    delete_document as delete_json_document,
    document_to_item,
    get_document as get_json_document,
    list_documents as list_json_documents,
    normalize_ipophl_task_id,
    resolve_file_path,
    upsert_document as upsert_json_document,
)
from config.models import DocumentAnalysis, db
from config.security import api_error, safe_error_message
from config.validation import (
    IPOPHL_PHASES,
    MAX_UPLOAD_BYTES,
    validate_enum,
    validate_filename_extension,
    validate_uuid_like,
)
from config.utils import get_current_user_phone, is_authenticated, log_activity
from api.gi_contributions_api import (
    _count_admin_gi_rows,
    _load_ipophl_disk_files,
    publish_gi_registration_fallback_to_gi_updates,
    publish_ipophl_registration_to_gi_updates,
    publish_ipophl_task_to_gi_updates,
)
from config.ipophl_store import collect_registration_file_uuids, filter_uuids_on_disk


def _is_db_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(
        x in text
        for x in (
            "mysql",
            "pymysql",
            "sqlalchemy",
            "operationalerror",
            "access denied",
            "timed out",
            "can't connect",
        )
    )


def _supersede_prior_uploads(*, file_uuid: str, task_id: str, original_filename: str) -> None:
    """Remove older records with the same task + filename so analysis matches latest upload."""
    from config.ipophl_store import list_documents

    task_id = normalize_ipophl_task_id(task_id)
    norm_name = secure_filename((original_filename or "").strip()) or (original_filename or "").strip()
    if not task_id or not norm_name:
        return

    for record in list_documents(task_id=task_id, limit=100):
        old_uuid = str(record.get("file_uuid") or "").strip()
        if not old_uuid or old_uuid == file_uuid:
            continue
        old_name = secure_filename(
            str(record.get("original_filename") or record.get("filename") or "").strip()
        )
        if old_name != norm_name:
            continue
        old_path = str(record.get("file_path") or "").strip()
        if old_path and os.path.exists(old_path):
            try:
                os.remove(old_path)
            except OSError:
                pass
        _delete_document_record(old_uuid)


def _ingest_ipophl_upload(file, *, task_id: str, ipophl_phase: str | None = None) -> str:
    """
    Save one IPOPHL file to disk + JSON (same as /api/ipo-analyze).
    Returns file_uuid. Used when admin clicks Complete Registration (batch upload).
    """
    from machinelearning.ai_engine import gi_analyzer

    if not file or not getattr(file, "filename", None) or file.filename == "":
        raise ValueError("No file provided")

    ok_name, name_err, file_ext = validate_filename_extension(file.filename)
    if not ok_name:
        raise ValueError(name_err)

    task_id = normalize_ipophl_task_id(task_id)
    phase = ipophl_phase or (
        task_id.split("-", 1)[0] if task_id.startswith("phase") else "unknown"
    )
    phase = validate_enum(phase, IPOPHL_PHASES, "unknown")

    raw_path = gi_analyzer.save_uploaded_file(file, file.filename)
    file_path_obj = Path(raw_path)
    relative_path = f"machinelearning/uploads/{file_path_obj.name}"
    file_uuid = file_path_obj.stem

    try:
        analysis_result = gi_analyzer.analyze_document(str(file_path_obj), task_id=task_id)
    except Exception:
        analysis_result = {"success": True, "readiness_score": 50, "status": "Uploaded"}

    resolved_task = analysis_result.get("task_id")
    if resolved_task:
        task_id = normalize_ipophl_task_id(resolved_task)
        phase = ipophl_phase or (
            task_id.split("-", 1)[0] if task_id.startswith("phase") else "unknown"
        )
        phase = validate_enum(phase, IPOPHL_PHASES, "unknown")

    if not analysis_result.get("success", False):
        analysis_result = {
            "success": True,
            "readiness_score": 10,
            "status": "Uploaded",
            "detected_features": [],
            "missing_requirements": [],
            "analysis_method": "upload_only",
            "text_length": 0,
            "shap_analysis": "",
        }

    existing_record = get_json_document(file_uuid)
    raw_upload_name = (file.filename or "").strip()
    stored_display_name = secure_filename(raw_upload_name) or f"document{file_ext}"

    if existing_record:
        doc_analysis = DocumentAnalysis(
            file_uuid=file_uuid,
            original_filename=stored_display_name,
            file_path=relative_path,
            file_type=file_ext,
            file_size=int(os.path.getsize(str(file_path_obj))),
            ipophl_phase=phase,
            task_id=task_id,
        )
    else:
        doc_analysis = DocumentAnalysis(
            file_uuid=file_uuid,
            original_filename=stored_display_name,
            file_path=relative_path,
            file_type=file_ext,
            file_size=os.path.getsize(str(file_path_obj)),
            ipophl_phase=phase,
            task_id=task_id,
        )

    doc_analysis.ai_score = int(analysis_result.get("readiness_score") or 50)
    doc_analysis.ai_status = str(analysis_result.get("status") or "Uploaded")
    doc_analysis.set_detected_features(analysis_result.get("detected_features") or [])
    doc_analysis.set_missing_requirements(analysis_result.get("missing_requirements") or [])
    doc_analysis.analysis_method = analysis_result.get("analysis_method") or "rule_based"
    doc_analysis.text_length = int(analysis_result.get("text_length") or 0)
    doc_analysis.shap_analysis = analysis_result.get("shap_analysis") or ""
    doc_analysis.analysis_timestamp = datetime.utcnow()
    sb = analysis_result.get("score_breakdown")
    doc_analysis.score_breakdown = sb if isinstance(sb, dict) else None
    ipa = analysis_result.get("ip_pillar_assessment")
    doc_analysis.ip_pillar_assessment = ipa if isinstance(ipa, dict) else None

    _persist_document(doc_analysis, is_new=existing_record is None)
    _supersede_prior_uploads(
        file_uuid=file_uuid,
        task_id=task_id,
        original_filename=stored_display_name,
    )
    return file_uuid


def _persist_document_sqlalchemy(doc_analysis, *, is_new: bool) -> None:
    """Upsert document_analysis via SQLAlchemy when app DB is reachable."""
    existing = DocumentAnalysis.query.filter_by(file_uuid=doc_analysis.file_uuid).first()
    if existing:
        existing.original_filename = doc_analysis.original_filename
        existing.file_path = doc_analysis.file_path
        existing.file_type = doc_analysis.file_type
        existing.file_size = int(doc_analysis.file_size or 0)
        existing.ai_score = int(doc_analysis.ai_score or 0)
        existing.ai_status = doc_analysis.ai_status or "Not Ready"
        existing.set_detected_features(doc_analysis.detected_features_list)
        existing.set_missing_requirements(doc_analysis.missing_requirements_list)
        existing.analysis_method = doc_analysis.analysis_method or "rule_based"
        existing.text_length = int(doc_analysis.text_length or 0)
        existing.shap_analysis = doc_analysis.shap_analysis or ""
        existing.analysis_timestamp = doc_analysis.analysis_timestamp or datetime.utcnow()
        existing.ipophl_phase = doc_analysis.ipophl_phase or ""
        existing.task_id = doc_analysis.task_id or ""
    elif is_new:
        db.session.add(doc_analysis)
    else:
        db.session.merge(doc_analysis)
    db.session.commit()


def _persist_document(doc_analysis, *, is_new: bool) -> str:
    """
    Save analysis metadata to local JSON, Supabase REST, SQLAlchemy, and optional HTTP bridge.
    """
    import beanthentic_env

    record = upsert_payload_from_model(doc_analysis)
    upsert_json_document(record)

    sources: list[str] = ["local_json"]

    if beanthentic_env.uses_supabase_anon():
        try:
            from config.supabase_ipophl_store import upsert_document_analysis_via_rest

            upsert_document_analysis_via_rest(record)
            sources.append("supabase_rest")
        except Exception:
            pass

    if beanthentic_env.is_postgresql() or app_db_params():
        try:
            _persist_document_sqlalchemy(doc_analysis, is_new=is_new)
            if "postgresql" not in sources and "supabase_rest" not in sources:
                sources.append("postgresql")
            elif "postgresql" not in sources:
                sources.append("postgresql")
        except Exception:
            db.session.rollback()

    # Sync to XAMPP in the background so upload does not wait on LAN :8080 timeouts.
    if app_server_base():

        def _sync_http() -> None:
            try:
                http_upsert_document(record, timeout=4)
            except Exception:
                pass

        threading.Thread(target=_sync_http, daemon=True).start()
        sources.append("app_server_http_async")

    return "+".join(sources)


def _find_document_mysql(file_uuid: str):
    doc = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
    if doc:
        return doc
    safe_name = secure_filename(file_uuid)
    return DocumentAnalysis.query.filter(
        (DocumentAnalysis.original_filename == file_uuid)
        | (DocumentAnalysis.original_filename == safe_name)
        | (DocumentAnalysis.original_filename.like(f"{file_uuid}.%"))
        | (DocumentAnalysis.original_filename.like(f"{safe_name}.%"))
    ).first()


def _doc_record_from_http(data: dict) -> SimpleNamespace:
    analysis = data.get("analysis") if isinstance(data.get("analysis"), dict) else {}
    detected = analysis.get("detected_features", [])
    missing = analysis.get("missing_requirements", [])
    return SimpleNamespace(
        file_uuid=data.get("file_uuid", ""),
        original_filename=data.get("filename") or data.get("original_filename", ""),
        file_path=data.get("file_path", ""),
        file_type=data.get("file_type", ""),
        file_size=int(data.get("file_size") or 0),
        ipophl_phase=data.get("ipophl_phase", ""),
        task_id=data.get("task_id", ""),
        ai_score=int(analysis.get("readiness_score") or 0),
        ai_status=analysis.get("status", "Not Ready"),
        detected_features_list=detected if isinstance(detected, list) else [],
        missing_requirements_list=missing if isinstance(missing, list) else [],
        analysis_method=analysis.get("analysis_method", "rule_based"),
        text_length=int(analysis.get("text_length") or 0),
        shap_analysis=analysis.get("shap_analysis", ""),
        score_breakdown=analysis.get("score_breakdown"),
        ip_pillar_assessment=analysis.get("ip_pillar_assessment"),
        upload_timestamp=data.get("upload_timestamp"),
        analysis_timestamp=analysis.get("analysis_timestamp"),
    )


def _doc_record_from_json(record: dict) -> SimpleNamespace:
    analysis = analysis_payload_from_record(record)
    return SimpleNamespace(
        file_uuid=record.get("file_uuid", ""),
        original_filename=record.get("original_filename") or record.get("filename", ""),
        file_path=record.get("file_path", ""),
        file_type=record.get("file_type", ""),
        file_size=int(record.get("file_size") or 0),
        ipophl_phase=record.get("ipophl_phase", ""),
        task_id=record.get("task_id", ""),
        ai_score=int(analysis.get("readiness_score") or 0),
        ai_status=analysis.get("status", "Not Ready"),
        detected_features_list=analysis.get("detected_features", []),
        missing_requirements_list=analysis.get("missing_requirements", []),
        analysis_method=analysis.get("analysis_method", "rule_based"),
        text_length=int(analysis.get("text_length") or 0),
        shap_analysis=analysis.get("shap_analysis", ""),
        score_breakdown=analysis.get("score_breakdown"),
        ip_pillar_assessment=analysis.get("ip_pillar_assessment"),
        upload_timestamp=record.get("upload_timestamp"),
        analysis_timestamp=analysis.get("analysis_timestamp"),
    )


def _find_document(file_uuid: str):
    """Local JSON first, then HTTP bridge, then SQLAlchemy (slow when LAN MySQL is down)."""
    record = get_json_document(file_uuid)
    if record:
        return _doc_record_from_json(record), "local_json"

    if app_server_base():
        try:
            data = http_get_document(file_uuid, timeout=4)
            return _doc_record_from_http(data), "app_server_http"
        except RuntimeError as e:
            if str(e) != "NOT_FOUND":
                pass

    if app_db_params():
        try:
            doc = _find_document_mysql(file_uuid)
            if doc:
                return doc, "app_mysql"
        except Exception:
            pass

    path = resolve_file_path(file_uuid)
    if path and path.exists():
        return _doc_record_from_json({
            "file_uuid": file_uuid,
            "original_filename": path.name,
            "file_path": path.as_posix(),
            "file_type": path.suffix,
            "file_size": path.stat().st_size,
            "ai_score": 0,
            "ai_status": "Uploaded - pending review",
            "detected_features": [],
            "missing_requirements": [],
            "analysis_method": "disk_only",
            "text_length": 0,
            "shap_analysis": "",
            "upload_timestamp": datetime.utcnow().isoformat(timespec="seconds"),
            "analysis_timestamp": datetime.utcnow().isoformat(timespec="seconds"),
            "ipophl_phase": "unknown",
            "task_id": "unknown",
        }), "disk_only"

    return None, ""


def _delete_document_record(file_uuid: str) -> None:
    import beanthentic_env

    delete_json_document(file_uuid)

    if beanthentic_env.uses_supabase_anon():
        try:
            from config.supabase_ipophl_store import delete_document_analysis_via_rest

            delete_document_analysis_via_rest(file_uuid)
        except Exception:
            pass

    if app_db_params() or beanthentic_env.is_postgresql():
        try:
            doc = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
            if doc:
                db.session.delete(doc)
                db.session.commit()
        except Exception:
            db.session.rollback()

    if app_server_base():
        try:
            http_delete_document(file_uuid)
        except Exception:
            pass


def _list_documents(phase: str | None, task_id: str | None, limit: int) -> tuple[list[dict], str]:
    bootstrap_orphan_uploads(limit=limit)
    items = [document_to_item(record) for record in list_json_documents(phase=phase, task_id=task_id, limit=limit)]
    if items:
        return items, "local_json"

    if app_server_base():
        try:
            remote = http_list_documents(phase=phase, task_id=task_id, limit=limit, timeout=4)
            if remote:
                return remote, "app_server_http"
        except Exception:
            pass

    if app_db_params():
        try:
            query = DocumentAnalysis.query
            if phase:
                query = query.filter(DocumentAnalysis.ipophl_phase == phase)
            if task_id:
                query = query.filter(DocumentAnalysis.task_id == task_id)
            documents = (
                query.order_by(DocumentAnalysis.upload_timestamp.desc()).limit(limit).all()
            )
            if documents:
                items = [
                    {
                        "file_uuid": doc.file_uuid,
                        "filename": doc.original_filename,
                        "file_type": doc.file_type,
                        "file_size": doc.file_size,
                        "upload_timestamp": doc.upload_timestamp.isoformat(),
                        "ai_score": doc.ai_score,
                        "ai_status": doc.ai_status,
                        "ipophl_phase": doc.ipophl_phase,
                        "task_id": doc.task_id,
                    }
                    for doc in documents
                ]
                return items, "app_mysql"
        except Exception:
            pass

    return [], "local_json"


def _stored_dict_field(record: dict | None, key: str) -> dict | None:
    if not isinstance(record, dict):
        return None
    raw = record.get(key)
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass
    return None


def _dict_field_for_doc(doc, key: str) -> dict | None:
    raw = getattr(doc, key, None)
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, TypeError):
            pass
    file_uuid = str(getattr(doc, "file_uuid", "") or "").strip()
    if file_uuid:
        return _stored_dict_field(get_json_document(file_uuid), key)
    return None


def _score_breakdown_for_doc(doc) -> dict | None:
    return _dict_field_for_doc(doc, "score_breakdown")


def _ip_pillar_assessment_for_doc(doc) -> dict | None:
    return _dict_field_for_doc(doc, "ip_pillar_assessment")


def _analysis_response(doc) -> dict:
    from machinelearning.ai_engine import gi_analyzer

    payload = {
        "readiness_score": doc.ai_score,
        "status": doc.ai_status,
        "detected_features": doc.detected_features_list,
        "missing_requirements": doc.missing_requirements_list,
        "analysis_method": doc.analysis_method,
        "text_length": doc.text_length,
        "shap_analysis": doc.shap_analysis,
        "score_breakdown": _score_breakdown_for_doc(doc),
        "ip_pillar_assessment": _ip_pillar_assessment_for_doc(doc),
        "analysis_timestamp": (
            doc.analysis_timestamp.isoformat()
            if hasattr(doc.analysis_timestamp, "isoformat") and doc.analysis_timestamp
            else doc.analysis_timestamp
        ),
    }
    return gi_analyzer.normalize_analysis_payload(payload)


def _ipophl_recipient_email() -> str:
    return (
        os.getenv("BEANTHENTIC_IPOPHL_EMAIL", "").strip()
        or "info@ipophl.gov.ph"
    )


def _build_gmail_compose_url(*, to: str, subject: str, body: str) -> str:
    query = urllib.parse.urlencode(
        {"view": "cm", "fs": "1", "to": to, "su": subject, "body": body},
        quote_via=urllib.parse.quote,
    )
    return f"https://mail.google.com/mail/?{query}"


def _ipophl_gmail_compose_payload(*, file_labels: list[str] | None = None) -> dict:
    to = _ipophl_recipient_email()
    subject = "Beanthentic — GI Registration Documents"
    lines = [
        "Dear IPOPHL,",
        "",
        "Please find attached our GI registration documents for Beanthentic.",
        "",
        "This submission was prepared through the Beanthentic admin IPOPHL module.",
    ]
    if file_labels:
        lines.extend(["", "Documents included:", *[f"- {name}" for name in file_labels]])
    lines.extend(
        [
            "",
            "Attach the downloaded zip file (beanthentic-ipophl-registration.zip) to this email before sending.",
            "",
            "Thank you.",
        ]
    )
    body = "\n".join(lines)
    return {
        "to": to,
        "subject": subject,
        "body": body,
        "gmail_url": _build_gmail_compose_url(to=to, subject=subject, body=body),
    }


def register_ipophl_routes(app):
    """Register IPOPHL document analysis routes with the Flask app."""

    def _guard_uuid(file_uuid: str):
        ok, err = validate_uuid_like(file_uuid)
        if not ok:
            return api_error(err, 400)
        return None

    @app.route("/api/ipo-preview/<file_uuid>")
    def api_ipo_file_preview(file_uuid):
        """Preview a specific uploaded file in the IPOPHL module."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        guard = _guard_uuid(file_uuid)
        if guard:
            return guard

        try:
            doc_analysis, source = _find_document(file_uuid)
            if not doc_analysis:
                return jsonify({"error": "File not found"}), 404

            file_path = Path(doc_analysis.file_path) if doc_analysis.file_path else None
            if not file_path or not file_path.exists():
                resolved = resolve_file_path(file_uuid, filename_hint=getattr(doc_analysis, "original_filename", None))
                if not resolved:
                    return jsonify({"error": "File not found on disk"}), 404
                file_path = resolved

            upload_ts = doc_analysis.upload_timestamp
            if hasattr(upload_ts, "isoformat"):
                upload_ts = upload_ts.isoformat()

            return jsonify({
                "success": True,
                "source": source,
                "file_info": {
                    "filename": doc_analysis.original_filename,
                    "file_type": doc_analysis.file_type,
                    "file_size": doc_analysis.file_size,
                    "upload_timestamp": upload_ts,
                    "ipophl_phase": doc_analysis.ipophl_phase,
                    "task_id": doc_analysis.task_id,
                },
                "preview_url": f"/api/file-preview/{file_uuid}{doc_analysis.file_type}",
                "analysis": {
                    "ai_score": doc_analysis.ai_score,
                    "ai_status": doc_analysis.ai_status,
                    "detected_features": doc_analysis.detected_features_list,
                    "missing_requirements": doc_analysis.missing_requirements_list,
                    "shap_analysis": doc_analysis.shap_analysis,
                },
            })

        except Exception as e:
            if _is_db_error(e):
                return jsonify({"error": safe_error_message(e)}), 503
            return jsonify({"error": safe_error_message(e, public="Preview failed.")}), 500

    @app.route("/api/ipo-analyze", methods=["POST"])
    def api_ipo_analyze():
        """Handle file upload and AI analysis for IPOPHL documents."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        try:
            from machinelearning.ai_engine import gi_analyzer

            if "file" not in request.files:
                return jsonify({"error": "No file provided"}), 400

            file = request.files["file"]
            if file.filename == "":
                return jsonify({"error": "No file selected"}), 400

            if request.content_length and request.content_length > MAX_UPLOAD_BYTES:
                return api_error(
                    f"File too large. Maximum size is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
                    400,
                )

            ok_name, name_err, file_ext = validate_filename_extension(file.filename)
            if not ok_name:
                return api_error(name_err, 400)

            ipophl_phase = validate_enum(
                request.form.get("phase", "unknown"), IPOPHL_PHASES, "unknown"
            )
            task_id = normalize_ipophl_task_id(request.form.get("task_id"))
            file_uuid = _ingest_ipophl_upload(
                file, task_id=task_id, ipophl_phase=ipophl_phase
            )
            doc_analysis = get_json_document(file_uuid)
            source = "local_json"
            if doc_analysis:
                doc_analysis = _doc_record_from_json(doc_analysis)
            else:
                doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
            if not doc_analysis:
                return jsonify({"error": "Could not save document."}), 500

            try:
                user_phone = get_current_user_phone()
                log_activity(
                    user_phone,
                    "IPOPHL_DOCUMENT_ANALYZED",
                    f"Analyzed {file.filename} - Score: {doc_analysis.ai_score}%",
                    request.remote_addr,
                )
            except Exception:
                pass

            preview_path = str(getattr(doc_analysis, "file_path", "") or "")
            gi_publish: dict = {"ok": False}
            try:
                gi_publish = publish_ipophl_task_to_gi_updates(
                    file_uuid=file_uuid,
                    task_id=task_id,
                )
            except Exception as pub_err:
                gi_publish = {"ok": False, "error": str(pub_err)}

            return jsonify({
                "success": True,
                "file_uuid": file_uuid,
                "filename": file.filename,
                "source": source,
                "analysis": _analysis_response(doc_analysis),
                "preview_url": gi_analyzer.get_file_preview_url(preview_path),
                "ipophl_phase": ipophl_phase,
                "task_id": task_id,
                "gi_publish": gi_publish,
            })

        except Exception as e:
            return jsonify({"error": safe_error_message(e, public="Analysis failed.")}), 500

    @app.route("/api/ipo-delete/<file_uuid>", methods=["DELETE"])
    def api_delete_ipo_file(file_uuid):
        """Delete an IPOPHL document."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        guard = _guard_uuid(file_uuid)
        if guard:
            return guard

        try:
            doc_analysis, _source = _find_document(file_uuid)
            if not doc_analysis:
                return jsonify({"error": "Document not found"}), 404

            from config.ipophl_store import normalize_ipophl_task_id
            from api.gi_contributions_api import sync_ipophl_category_gi_updates

            task_id = normalize_ipophl_task_id(
                getattr(doc_analysis, "task_id", None)
                or (get_json_document(file_uuid) or {}).get("task_id")
            )

            file_path = doc_analysis.file_path
            if file_path and os.path.exists(file_path):
                os.remove(file_path)

            _delete_document_record(file_uuid)

            gi_sync: dict = {"ok": True, "cleared": True}
            try:
                gi_sync = sync_ipophl_category_gi_updates(task_id)
            except Exception as gi_err:
                gi_sync = {"ok": False, "error": str(gi_err)}

            try:
                user_phone = get_current_user_phone()
                log_activity(
                    user_phone,
                    "IPOPHL_DOCUMENT_DELETED",
                    f"Deleted {doc_analysis.original_filename}",
                    request.remote_addr,
                )
            except Exception:
                pass

            return jsonify({"success": True, "gi_sync": gi_sync})

        except Exception as e:
            return jsonify({"error": safe_error_message(e, public="Deletion failed.")}), 500

    @app.route("/api/file-preview/<filename>")
    def api_file_preview(filename):
        """Serve file for preview."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        safe_name = secure_filename(filename)
        if not safe_name or safe_name != filename.replace("\\", "/").split("/")[-1]:
            return jsonify({"error": "Invalid file name."}), 400

        try:
            file_uuid = safe_name.rsplit(".", 1)[0] if "." in safe_name else safe_name
            ok_uuid, uuid_err = validate_uuid_like(file_uuid)
            if not ok_uuid:
                return jsonify({"error": uuid_err}), 400

            doc_analysis, _source = _find_document(file_uuid)
            if not doc_analysis:
                return jsonify({"error": "File not found"}), 404

            file_path = Path(doc_analysis.file_path) if doc_analysis.file_path else None
            if not file_path or not file_path.exists():
                resolved = resolve_file_path(file_uuid, filename_hint=safe_name)
                if not resolved:
                    return jsonify({"error": "File not found on disk"}), 404
                file_path = resolved

            mimetype = None
            suffix = file_path.suffix.lower()
            if suffix == ".pdf":
                mimetype = "application/pdf"
            elif suffix == ".csv":
                mimetype = "text/plain"
            elif suffix in [".doc", ".docx"]:
                mimetype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

            return send_file(str(file_path), as_attachment=False, mimetype=mimetype)

        except Exception as e:
            if _is_db_error(e):
                return jsonify({"error": safe_error_message(e)}), 503
            return jsonify({"error": safe_error_message(e, public="Preview failed.")}), 500

    @app.route("/api/ipo-analysis/<file_uuid>", methods=["GET"])
    def api_get_ipo_analysis(file_uuid):
        """Get analysis results for a specific document."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        guard = _guard_uuid(file_uuid)
        if guard:
            return guard

        try:
            doc_analysis, source = _find_document(file_uuid)
            if not doc_analysis:
                return jsonify({"error": "Document not found"}), 404

            return jsonify({
                "success": True,
                "source": source,
                "file_uuid": doc_analysis.file_uuid,
                "filename": doc_analysis.original_filename,
                "analysis": _analysis_response(doc_analysis),
                "ipophl_phase": doc_analysis.ipophl_phase,
                "task_id": doc_analysis.task_id,
            })

        except Exception as e:
            if _is_db_error(e):
                return jsonify({"error": safe_error_message(e)}), 503
            return jsonify({"error": safe_error_message(e, public="Failed to retrieve analysis.")}), 500

    @app.route("/api/ipo-analysis/<file_uuid>", methods=["POST"])
    def api_update_ipo_analysis(file_uuid):
        """Re-run AI analysis for a document (no manual score override from client)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        guard = _guard_uuid(file_uuid)
        if guard:
            return guard

        try:
            doc_analysis, _source = _find_document(file_uuid)
            if not doc_analysis:
                return jsonify({"error": "Document not found"}), 404

            payload = request.get_json(silent=True) or {}
            if payload:
                return api_error(
                    "Manual analysis overrides are not allowed. Send an empty body to re-run analysis.",
                    400,
                )

            from machinelearning.ai_engine import gi_analyzer

            file_path = doc_analysis.file_path
            path_obj = Path(file_path) if file_path else None
            if not path_obj or not path_obj.exists():
                resolved = resolve_file_path(file_uuid, filename_hint=getattr(doc_analysis, "original_filename", None))
                if not resolved:
                    return jsonify({"error": "File not found on disk"}), 404
                path_obj = resolved
                file_path = path_obj.as_posix()

            result = gi_analyzer.analyze_document(str(path_obj), task_id=doc_analysis.task_id)
            if not result.get("success"):
                return jsonify({"error": "Re-analysis failed."}), 500

            resolved_task = result.get("task_id")
            if resolved_task:
                doc_analysis.task_id = normalize_ipophl_task_id(resolved_task)
                if doc_analysis.task_id.startswith("phase"):
                    doc_analysis.ipophl_phase = doc_analysis.task_id.split("-", 1)[0]

            if not isinstance(doc_analysis, DocumentAnalysis):
                doc_analysis = DocumentAnalysis(
                    file_uuid=file_uuid,
                    original_filename=doc_analysis.original_filename,
                    file_path=file_path,
                    file_type=doc_analysis.file_type,
                    file_size=doc_analysis.file_size,
                    ipophl_phase=doc_analysis.ipophl_phase,
                    task_id=doc_analysis.task_id,
                )

            doc_analysis.ai_score = result["readiness_score"]
            doc_analysis.ai_status = result["status"]
            doc_analysis.set_detected_features(result["detected_features"])
            doc_analysis.set_missing_requirements(result["missing_requirements"])
            doc_analysis.analysis_method = result["analysis_method"]
            doc_analysis.text_length = result["text_length"]
            doc_analysis.shap_analysis = result.get("shap_analysis", "")
            doc_analysis.analysis_timestamp = datetime.utcnow()
            sb = result.get("score_breakdown")
            doc_analysis.score_breakdown = sb if isinstance(sb, dict) else None
            ipa = result.get("ip_pillar_assessment")
            doc_analysis.ip_pillar_assessment = ipa if isinstance(ipa, dict) else None
            _persist_document(doc_analysis, is_new=False)

            try:
                user_phone = get_current_user_phone()
                log_activity(
                    user_phone,
                    "IPOPHL_DOCUMENT_UPDATED",
                    f"Updated analysis for {doc_analysis.original_filename}",
                    request.remote_addr,
                )
            except Exception:
                pass

            return jsonify({
                "success": True,
                "analysis": _analysis_response(doc_analysis),
            })

        except Exception as e:
            if _is_db_error(e):
                return jsonify({"error": safe_error_message(e)}), 503
            return jsonify({"error": safe_error_message(e, public="Failed to update analysis.")}), 500

    @app.route("/api/ipo-documents", methods=["GET"])
    def api_list_ipo_documents():
        """List all IPOPHL documents."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        try:
            phase = request.args.get("phase")
            task_id = request.args.get("task_id")
            limit = min(max(request.args.get("limit", 50, type=int) or 50, 1), 200)

            items, source = _list_documents(phase, task_id, limit)
            return jsonify({"items": items, "count": len(items), "source": source})

        except Exception as e:
            return jsonify({"error": safe_error_message(e, public="Failed to list documents.")}), 500

    @app.route("/api/ipophl/publish-preflight", methods=["GET"])
    def api_ipophl_publish_preflight():
        """Fast check before Complete Registration (browser can call this first)."""
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        from api.gi_contributions_api import check_xampp_for_publish

        return jsonify(check_xampp_for_publish())

    @app.route("/api/ipophl/publish-task", methods=["POST"])
    def api_ipophl_publish_task():
        """Publish one uploaded IPOPHL document to all farmers' GI Updates."""
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401

        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}
        file_uuid = str(body.get("file_uuid") or request.form.get("file_uuid") or "").strip()
        task_id = str(body.get("task_id") or request.form.get("task_id") or "").strip() or None
        if not file_uuid:
            return jsonify({"ok": False, "error": "file_uuid is required"}), 400
        try:
            result = publish_ipophl_task_to_gi_updates(file_uuid=file_uuid, task_id=task_id)
            return jsonify({"ok": True, **result})
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e)}), 400
        except RuntimeError as e:
            return jsonify({"ok": False, "error": str(e)}), 503
        except Exception as e:
            return jsonify(
                {"ok": False, "error": safe_error_message(e, public="GI publish failed.")}
            ), 503

    @app.route("/api/ipophl/registration-zip", methods=["GET"])
    def api_ipophl_registration_zip():
        """Zip all saved IPOPHL registration files for Gmail attachment."""
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401

        bootstrap_orphan_uploads(limit=500)
        file_uuids = filter_uuids_on_disk(collect_registration_file_uuids())
        disk_files = _load_ipophl_disk_files(file_uuids)
        if not disk_files:
            return jsonify({"ok": False, "error": "No registration files found on disk."}), 404

        buf = io.BytesIO()
        used_names: set[str] = set()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, path in disk_files:
                arcname = str(name or path.name).strip() or path.name
                base, ext = os.path.splitext(arcname)
                candidate = arcname
                n = 2
                while candidate in used_names:
                    candidate = f"{base}_{n}{ext}"
                    n += 1
                used_names.add(candidate)
                zf.write(path, arcname=candidate)
        buf.seek(0)
        return send_file(
            buf,
            mimetype="application/zip",
            as_attachment=True,
            download_name="beanthentic-ipophl-registration.zip",
        )

    @app.route("/api/ipophl/compile-preview", methods=["GET"])
    def api_ipophl_compile_preview():
        """List Phase 1–3 source files that will be merged in Compile."""
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401
        try:
            from config.ipophl_compile import collect_compile_sources

            bootstrap_orphan_uploads(limit=500)
            sources = collect_compile_sources()
            return jsonify(
                {
                    "ok": True,
                    "count": len(sources),
                    "items": [
                        {
                            "file_uuid": s["file_uuid"],
                            "task_id": s["task_id"],
                            "label": s["label"],
                            "original_filename": s["original_filename"],
                        }
                        for s in sources
                    ],
                }
            )
        except Exception as e:
            return jsonify(
                {"ok": False, "error": safe_error_message(e, public="Could not list compile sources.")}
            ), 500

    @app.route("/api/ipophl/compile-package", methods=["GET", "POST"])
    def api_ipophl_compile_package():
        """
        Merge all Phase 1–3 IPOPHL uploads into one PDF or DOCX for local download.
        Query/body: format=pdf|docx, optional file_uuids[].
        """
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401

        body: dict = {}
        if request.method == "POST" and request.is_json:
            body = request.get_json(silent=True) or {}
            if not isinstance(body, dict):
                body = {}

        fmt = (
            str(body.get("format") or request.args.get("format") or "pdf")
            .strip()
            .lower()
        )
        raw_uuids = body.get("file_uuids") if isinstance(body.get("file_uuids"), list) else None
        if raw_uuids is None:
            q = request.args.get("file_uuids") or ""
            raw_uuids = [u.strip() for u in q.split(",") if u.strip()] if q else None

        try:
            from config.ipophl_compile import compile_ipophl_package

            bootstrap_orphan_uploads(limit=500)
            payload, download_name, mime, summaries = compile_ipophl_package(
                fmt=fmt,
                file_uuids=raw_uuids,
            )
            try:
                log_activity(
                    get_current_user_phone() or "admin",
                    "ipophl_compile_package",
                    f"format={fmt}; files={len(summaries)}",
                    request.remote_addr,
                )
            except Exception:
                pass
            buf = io.BytesIO(payload)
            buf.seek(0)
            response = send_file(
                buf,
                mimetype=mime,
                as_attachment=True,
                download_name=download_name,
            )
            response.headers["X-Beanthentic-Compile-Count"] = str(len(summaries))
            response.headers["X-Beanthentic-Compile-Format"] = fmt
            return response
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e)}), 400
        except Exception as e:
            return jsonify(
                {
                    "ok": False,
                    "error": safe_error_message(
                        e, public="Could not compile documents. Try again or check uploads."
                    ),
                }
            ), 500

    @app.route("/api/ipophl/gmail-compose", methods=["GET"])
    def api_ipophl_gmail_compose():
        """Gmail compose URL + recipient for IPOPHL registration email."""
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401

        bootstrap_orphan_uploads(limit=500)
        file_uuids = filter_uuids_on_disk(collect_registration_file_uuids())
        disk_files = _load_ipophl_disk_files(file_uuids)
        labels = [str(name or path.name) for name, path in disk_files]
        payload = _ipophl_gmail_compose_payload(file_labels=labels)
        return jsonify({"ok": True, **payload, "file_count": len(labels)})

    @app.route("/api/ipophl/complete-registration", methods=["POST"])
    def api_ipophl_complete_registration():
        """
        Complete Registration (Phase 5): upload selected files + publish to app GI Updates (MySQL).
        Accepts JSON { file_uuids, file_entries } or multipart files[] + task_ids[] (like admin_gi_send).
        """
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401

        body: dict = {}
        if request.is_json:
            body = request.get_json(silent=True) or {}
            if not isinstance(body, dict):
                body = {}
        elif request.form.get("file_uuids_json"):
            try:
                import json as _json

                parsed = _json.loads(request.form.get("file_uuids_json") or "[]")
                if isinstance(parsed, list):
                    body["file_uuids"] = parsed
            except Exception:
                pass
        if request.form.get("file_entries_json"):
            try:
                import json as _json

                parsed = _json.loads(request.form.get("file_entries_json") or "[]")
                if isinstance(parsed, list):
                    body["file_entries"] = parsed
            except Exception:
                pass

        client_uuids: list[str] = []
        task_overrides: dict[str, str] = {}
        raw_uuids = body.get("file_uuids")
        if isinstance(raw_uuids, list):
            client_uuids = [str(u).strip() for u in raw_uuids if str(u).strip()]

        raw_entries = body.get("file_entries")
        if isinstance(raw_entries, list):
            for entry in raw_entries:
                if not isinstance(entry, dict):
                    continue
                uid = str(entry.get("file_uuid") or entry.get("id") or "").strip()
                tid = str(entry.get("task_id") or entry.get("service") or "").strip()
                if uid and uid not in client_uuids:
                    client_uuids.append(uid)
                if uid:
                    norm_tid = normalize_ipophl_task_id(tid)
                    if norm_tid and norm_tid != "ipophl-other":
                        task_overrides[uid] = norm_tid

        from api.gi_contributions_api import check_xampp_for_publish

        preflight = check_xampp_for_publish()
        if not preflight.get("ok"):
            return jsonify(
                {
                    "ok": False,
                    "error": preflight.get("error")
                    or "Cannot reach app MySQL or app server (port 8080).",
                    "hint": preflight.get("hint"),
                    "app_server_base": preflight.get("app_server_base"),
                    "xampp_reachable": preflight.get("xampp_reachable"),
                    "mysql_reachable": preflight.get("mysql_reachable"),
                }
            ), 503

        upload_errors: list[str] = []
        uploads = (
            request.files.getlist("files")
            or request.files.getlist("files[]")
            or request.files.getlist("file")
            or []
        )
        task_id_list = request.form.getlist("task_ids") or request.form.getlist("task_id") or []
        for index, upload in enumerate(uploads):
            if not upload or not getattr(upload, "filename", None) or upload.filename == "":
                continue
            tid = (
                task_id_list[index]
                if index < len(task_id_list)
                else (task_id_list[-1] if task_id_list else "ipophl-other")
            )
            try:
                uid = _ingest_ipophl_upload(upload, task_id=str(tid))
                if uid and uid not in client_uuids:
                    client_uuids.append(uid)
            except Exception as e:
                upload_errors.append(f"{upload.filename}: {e}")

        task_ids = body.get("task_ids")
        if not isinstance(task_ids, list) or not task_ids:
            task_ids = None

        from config.ipophl_store import bootstrap_orphan_uploads

        bootstrap_orphan_uploads(limit=500)
        file_uuids = collect_registration_file_uuids(
            file_uuids=client_uuids if client_uuids else None,
            task_ids=task_ids,
        )
        from config.ipophl_store import filter_uuids_on_disk

        file_uuids = filter_uuids_on_disk(file_uuids)

        publish_all_categories = str(
            body.get("publish_all_categories")
            or request.form.get("publish_all_categories")
            or "false"
        ).strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )

        force_publish = str(
            body.get("force_publish") or request.form.get("force_publish") or ""
        ).strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )

        title = str(body.get("title") or "").strip() or None
        content = str(body.get("content") or "").strip() or None
        category = str(body.get("category") or "ipophl_registration").strip() or "ipophl_registration"

        if task_overrides:
            apply_task_overrides_to_store(task_overrides)

        try:
            if file_uuids:
                try:
                    result = publish_ipophl_registration_to_gi_updates(
                        file_uuids=file_uuids,
                        title=title,
                        content=content,
                        category=category,
                        task_overrides=task_overrides or None,
                        publish_all_categories=publish_all_categories,
                    )
                except (ValueError, RuntimeError):
                    if not force_publish:
                        raise
                    result = publish_gi_registration_fallback_to_gi_updates(
                        title=title,
                        content=content,
                    )
            else:
                result = publish_gi_registration_fallback_to_gi_updates(
                    title=title,
                    content=content,
                )
            try:
                user_phone = get_current_user_phone()
                sent = int(result.get("sent_count") or len(result.get("gi_update_ids") or []))
                log_activity(
                    user_phone,
                    "IPOPHL_REGISTRATION_PUBLISHED",
                    f"Published {len(file_uuids)} file(s) to GI Updates ({sent} farmer inbox(es))",
                    request.remote_addr,
                )
            except Exception:
                pass
            try:
                db_rows = _count_admin_gi_rows()
            except Exception:
                db_rows = 0
            cards = int(result.get("cards_published") or 0)
            resolved = int(result.get("files_resolved") or 0)
            requested = int(result.get("files_requested") or len(file_uuids))
            with_files = int(result.get("categories_with_files") or 0)
            total_cats = int(result.get("categories_total") or 13)
            skipped = max(0, requested - resolved)
            msg = (
                f"Uploaded and published {with_files} file(s) to GI Updates "
                f"({cards} card(s) on the app). Open GI Updates on the phone and refresh."
            )
            if upload_errors:
                msg += " Some files failed: " + "; ".join(upload_errors[:3])
            if skipped:
                msg += f" {skipped} saved file(s) were missing on disk — select them again, then Complete."
            bootstrap_orphan_uploads(limit=500)
            all_uuids = filter_uuids_on_disk(
                collect_registration_file_uuids(file_uuids=file_uuids if file_uuids else None)
            )
            disk_for_email = _load_ipophl_disk_files(all_uuids)
            gmail = _ipophl_gmail_compose_payload(
                file_labels=[str(n or p.name) for n, p in disk_for_email]
            )
            return jsonify(
                {
                    "ok": True,
                    "file_count": len(file_uuids),
                    "db_rows": db_rows,
                    "message": msg,
                    "gmail": gmail,
                    **result,
                }
            )
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e), "detail": str(e)}), 400
        except RuntimeError as e:
            err_text = str(e).strip() or "Publish failed."
            return jsonify({"ok": False, "error": err_text, "detail": err_text}), 503
        except Exception as e:
            err_text = str(e).strip()
            public = safe_error_message(
                e,
                public="Could not save to GI Updates. Check MySQL (settings.json app_db_host) and app server :8080.",
            )
            return jsonify(
                {
                    "ok": False,
                    "error": err_text if err_text and err_text != public else public,
                    "detail": err_text or public,
                }
            ), 503
