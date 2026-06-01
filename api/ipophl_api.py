"""
IPOPHL document analysis API endpoints for Beanthentic application.

Provides endpoints for IPOPHL document upload, analysis, and retrieval.
When connected to the app DB, uses SQLAlchemy first and HTTP bridge fallback
(same pattern as farmer records and messages).
"""

import os
import threading
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
    publish_gi_registration_fallback_to_gi_updates,
    publish_ipophl_registration_to_gi_updates,
)
from config.ipophl_store import collect_registration_file_uuids


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


def _persist_document(doc_analysis, *, is_new: bool) -> str:
    """
    Save analysis metadata: try app MySQL and HTTP bridge when configured,
    always mirror to local JSON so ML uploads work when LAN DB is unreachable.
    """
    record = upsert_payload_from_model(doc_analysis)
    upsert_json_document(record)

    sources: list[str] = ["local_json"]

    # Sync to XAMPP in the background so upload does not wait on LAN :8080 timeouts.
    if app_server_base():

        def _sync_http() -> None:
            try:
                http_upsert_document(record, timeout=4)
            except Exception:
                pass

        threading.Thread(target=_sync_http, daemon=True).start()

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
    delete_json_document(file_uuid)

    if app_db_params():
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


def _analysis_response(doc) -> dict:
    return {
        "readiness_score": doc.ai_score,
        "status": doc.ai_status,
        "detected_features": doc.detected_features_list,
        "missing_requirements": doc.missing_requirements_list,
        "analysis_method": doc.analysis_method,
        "text_length": doc.text_length,
        "shap_analysis": doc.shap_analysis,
        "analysis_timestamp": (
            doc.analysis_timestamp.isoformat()
            if hasattr(doc.analysis_timestamp, "isoformat") and doc.analysis_timestamp
            else doc.analysis_timestamp
        ),
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

            raw_path = gi_analyzer.save_uploaded_file(file, file.filename)
            file_path_obj = Path(raw_path)
            file_path = file_path_obj.as_posix()

            analysis_result = gi_analyzer.analyze_document(str(file_path_obj), task_id=task_id)

            if not analysis_result.get("success", False):
                return jsonify({"error": analysis_result.get("error", "Analysis failed")}), 500

            file_uuid = file_path_obj.stem
            # Always store a portable relative path (survives PC moves / OneDrive paths).
            relative_path = f"machinelearning/uploads/{file_path_obj.name}"
            existing_record = get_json_document(file_uuid)
            existing_analysis = None
            if existing_record:
                existing_analysis = DocumentAnalysis(
                    file_uuid=file_uuid,
                    original_filename=existing_record.get("original_filename") or secure_filename(file.filename),
                    file_path=existing_record.get("file_path") or file_path,
                    file_type=existing_record.get("file_type") or file_ext,
                    file_size=int(existing_record.get("file_size") or os.path.getsize(str(file_path_obj))),
                    ipophl_phase=existing_record.get("ipophl_phase") or ipophl_phase,
                    task_id=existing_record.get("task_id") or task_id,
                )
                existing_analysis.ai_score = int(existing_record.get("ai_score") or 0)
                existing_analysis.ai_status = existing_record.get("ai_status") or "Not Ready"

            raw_upload_name = (file.filename or "").strip()
            stored_display_name = secure_filename(raw_upload_name) or f"document{file_ext}"

            if existing_analysis:
                doc_analysis = existing_analysis
                doc_analysis.original_filename = stored_display_name
                doc_analysis.file_path = relative_path
                doc_analysis.task_id = task_id
                doc_analysis.ipophl_phase = ipophl_phase
            else:
                doc_analysis = DocumentAnalysis(
                    file_uuid=file_uuid,
                    original_filename=stored_display_name,
                    file_path=relative_path,
                    file_type=file_ext,
                    file_size=os.path.getsize(str(file_path_obj)),
                    ipophl_phase=ipophl_phase,
                    task_id=task_id,
                )

            doc_analysis.ai_score = analysis_result.get("readiness_score", 0)
            doc_analysis.ai_status = analysis_result.get("status", "Not Ready")
            doc_analysis.set_detected_features(analysis_result.get("detected_features", []))
            doc_analysis.set_missing_requirements(analysis_result.get("missing_requirements", []))
            doc_analysis.analysis_method = analysis_result.get("analysis_method", "rule_based")
            doc_analysis.text_length = analysis_result.get("text_length", 0)
            doc_analysis.shap_analysis = analysis_result.get("shap_analysis", "")
            doc_analysis.analysis_timestamp = datetime.utcnow()

            source = _persist_document(doc_analysis, is_new=existing_analysis is None)

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

            return jsonify({
                "success": True,
                "file_uuid": file_uuid,
                "filename": file.filename,
                "source": source,
                "analysis": _analysis_response(doc_analysis),
                "preview_url": gi_analyzer.get_file_preview_url(file_path),
                "ipophl_phase": ipophl_phase,
                "task_id": task_id,
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

            file_path = doc_analysis.file_path
            if file_path and os.path.exists(file_path):
                os.remove(file_path)

            _delete_document_record(file_uuid)

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

            return jsonify({"success": True})

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

    @app.route("/api/ipophl/complete-registration", methods=["POST"])
    def api_ipophl_complete_registration():
        """Publish Phase 5 IPOPHL files to all farmers' GI Updates (mobile app)."""
        if not is_authenticated():
            return jsonify({"ok": False, "error": "Unauthorized"}), 401

        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}

        raw_uuids = body.get("file_uuids")
        client_uuids: list[str] = []
        if isinstance(raw_uuids, list):
            client_uuids = [str(u).strip() for u in raw_uuids if str(u).strip()]

        task_ids = body.get("task_ids")
        if not isinstance(task_ids, list) or not task_ids:
            task_ids = None

        from config.ipophl_store import bootstrap_orphan_uploads

        bootstrap_orphan_uploads(limit=500)
        file_uuids = collect_registration_file_uuids(file_uuids=client_uuids, task_ids=task_ids)

        task_overrides: dict[str, str] = {}
        raw_entries = body.get("file_entries")
        if isinstance(raw_entries, list):
            for entry in raw_entries:
                if not isinstance(entry, dict):
                    continue
                uid = str(entry.get("file_uuid") or entry.get("id") or "").strip()
                tid = str(entry.get("task_id") or entry.get("service") or "").strip()
                if uid:
                    norm_tid = normalize_ipophl_task_id(tid)
                    if norm_tid and norm_tid != "ipophl-other":
                        task_overrides[uid] = norm_tid
                    if uid not in file_uuids:
                        file_uuids.append(uid)

        publish_all_categories = str(body.get("publish_all_categories") or "").strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )

        force_publish = str(body.get("force_publish") or "").strip().lower() in (
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
            db_rows = _count_admin_gi_rows()
            cards = int(result.get("cards_published") or 0)
            resolved = int(result.get("files_resolved") or 0)
            requested = int(result.get("files_requested") or len(file_uuids))
            with_files = int(result.get("categories_with_files") or 0)
            total_cats = int(result.get("categories_total") or 13)
            skipped = max(0, requested - resolved)
            msg = (
                f"Published {cards} GI Update card(s) ({total_cats} IPOPHL categories). "
                f"{with_files} categor{'y' if with_files == 1 else 'ies'} include attached file(s)."
            )
            if skipped:
                msg += f" {skipped} file(s) were missing on this PC — re-upload in IPOPHL, then try again."
            return jsonify(
                {
                    "ok": True,
                    "file_count": len(file_uuids),
                    "db_rows": db_rows,
                    "message": msg,
                    **result,
                }
            )
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e)}), 400
        except Exception as e:
            err_text = str(e)
            return jsonify(
                {
                    "ok": False,
                    "error": safe_error_message(
                        e,
                        public="Could not save to GI Updates. Check MySQL (settings.json app_db_host) and app server :8080.",
                    ),
                    "detail": err_text,
                }
            ), 503
