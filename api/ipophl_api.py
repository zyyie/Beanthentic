"""
IPOPHL document analysis API endpoints for Beanthentic application.

Provides endpoints for IPOPHL document upload, analysis, and retrieval.
"""

import os
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

from flask import jsonify, request, send_file
from werkzeug.utils import secure_filename

from config import ipophl_store
from config.models import DocumentAnalysis, db
from config.security import api_error, safe_error_message
from config.validation import (
    ALLOWED_UPLOAD_EXTENSIONS,
    MAX_UPLOAD_BYTES,
    validate_enum,
    validate_filename_extension,
    validate_document_id,
    IPOPHL_PHASES,
)
from config.utils import get_current_user_phone, is_authenticated, log_activity


def _analysis_payload_from_result(analysis_result: dict) -> dict:
    return {
        "readiness_score": analysis_result.get("readiness_score", 0),
        "status": analysis_result.get("status", "Not Ready"),
        "detected_features": analysis_result.get("detected_features", []),
        "missing_requirements": analysis_result.get("missing_requirements", []),
        "analysis_method": analysis_result.get("analysis_method", "rule_based"),
        "text_length": analysis_result.get("text_length", 0),
        "shap_analysis": analysis_result.get("shap_analysis", ""),
    }


def _store_record_from_upload(
    *,
    file_uuid: str,
    filename: str,
    file_path: str,
    file_ext: str,
    file_size: int,
    ipophl_phase: str,
    task_id: str,
    analysis_payload: dict,
    uploaded_by: str = "",
) -> dict:
    return {
        "file_uuid": file_uuid,
        "original_filename": secure_filename(filename),
        "file_path": file_path,
        "file_type": file_ext,
        "file_size": file_size,
        "ipophl_phase": ipophl_phase,
        "task_id": task_id,
        "uploaded_by": (uploaded_by or "").strip(),
        "ai_score": analysis_payload["readiness_score"],
        "ai_status": analysis_payload["status"],
        "detected_features": analysis_payload["detected_features"],
        "missing_requirements": analysis_payload["missing_requirements"],
        "analysis_method": analysis_payload["analysis_method"],
        "text_length": analysis_payload["text_length"],
        "shap_analysis": analysis_payload["shap_analysis"],
    }


def _record_visible_to_user(rec: dict, current_user: str) -> bool:
    """Show own uploads; also show legacy rows so the admin can delete them."""
    uploaded_by = (rec.get("uploaded_by") or "").strip()
    if not uploaded_by:
        return True
    if not current_user:
        return True
    return uploaded_by == current_user


def _resolve_from_disk(file_uuid: str) -> dict | None:
    from machinelearning.ai_engine import gi_analyzer

    if ipophl_store.is_deleted(file_uuid):
        return None

    for path in gi_analyzer.uploads_dir.iterdir():
        if not path.is_file() or path.stem != file_uuid:
            continue
        if path.suffix.lower() not in ALLOWED_UPLOAD_EXTENSIONS:
            continue
        return {
            "file_uuid": file_uuid,
            "original_filename": path.name,
            "file_path": path.as_posix(),
            "file_type": path.suffix.lower(),
            "file_size": path.stat().st_size,
            "task_id": "unknown",
            "ipophl_phase": "unknown",
        }
    return None


def _resolve_document_record(file_uuid: str) -> dict | None:
    """Resolve metadata from local JSON store, disk, then MySQL (last — may be slow)."""
    file_uuid = (file_uuid or "").strip()
    if not file_uuid:
        return None

    stored = ipophl_store.get(file_uuid)
    if stored:
        return stored

    disk = _resolve_from_disk(file_uuid)
    if disk:
        return disk

    try:
        doc = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
        if doc:
            return {
                "file_uuid": doc.file_uuid,
                "original_filename": doc.original_filename,
                "file_path": doc.file_path,
                "file_type": doc.file_type,
                "file_size": doc.file_size,
                "ipophl_phase": doc.ipophl_phase,
                "task_id": doc.task_id,
                "ai_score": doc.ai_score,
                "ai_status": doc.ai_status,
                "detected_features": doc.detected_features_list,
                "missing_requirements": doc.missing_requirements_list,
                "analysis_method": doc.analysis_method,
                "text_length": doc.text_length,
                "shap_analysis": doc.shap_analysis or "",
            }
    except Exception:
        pass

    return None


def _resolve_local_record(file_uuid: str) -> dict | None:
    """Fast path for delete/list — never waits on MySQL."""
    file_uuid = (file_uuid or "").strip()
    if not file_uuid:
        return None
    stored = ipophl_store.get_raw(file_uuid)
    if stored:
        return stored
    return _resolve_from_disk(file_uuid)


def _remove_ipo_files_from_disk(file_uuid: str, record: dict | None = None) -> int:
    from machinelearning.ai_engine import gi_analyzer

    removed = 0
    if record:
        file_path = record.get("file_path")
        if file_path:
            path = Path(file_path)
            if path.is_file():
                path.unlink(missing_ok=True)
                removed += 1

    for path in gi_analyzer.uploads_dir.glob(f"{file_uuid}.*"):
        if path.is_file():
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def _bootstrap_disk_uploads() -> None:
    """Index files already on disk into the local JSON store (e.g. after DB outage)."""
    from machinelearning.ai_engine import gi_analyzer

    known = {r.get("file_uuid") for r in ipophl_store.list_all()}
    for path in gi_analyzer.uploads_dir.iterdir():
        if not path.is_file():
            continue
        if path.suffix.lower() not in ALLOWED_UPLOAD_EXTENSIONS:
            continue
        file_uuid = path.stem
        if file_uuid in known or ipophl_store.is_deleted(file_uuid):
            continue
        result = gi_analyzer.analyze_document(str(path), task_id="phase1-product")
        if not result.get("success"):
            continue
        payload = _analysis_payload_from_result(result)
        ipophl_store.upsert(
            _store_record_from_upload(
                file_uuid=file_uuid,
                filename=path.name,
                file_path=path.as_posix(),
                file_ext=path.suffix.lower(),
                file_size=path.stat().st_size,
                ipophl_phase="phase1",
                task_id="phase1-product",
                analysis_payload=payload,
            )
        )


def register_ipophl_routes(app):
    """Register IPOPHL document analysis routes with the Flask app."""

    def _guard_uuid(file_uuid: str):
        ok, err = validate_document_id(file_uuid)
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
            # Find document record
            doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
            if not doc_analysis:
                return jsonify({"error": "File not found"}), 404

            # Check if file exists
            file_path = Path(doc_analysis.file_path)
            if not file_path.exists():
                return jsonify({"error": "File not found on disk"}), 404

            # Return file info and preview URL
            return jsonify({
                "success": True,
                "file_info": {
                    "filename": doc_analysis.original_filename,
                    "file_type": doc_analysis.file_type,
                    "file_size": doc_analysis.file_size,
                    "upload_timestamp": doc_analysis.upload_timestamp.isoformat(),
                    "ipophl_phase": doc_analysis.ipophl_phase,
                    "task_id": doc_analysis.task_id
                },
                "preview_url": f"/api/file-preview/{file_uuid}{doc_analysis.file_type}",
                "analysis": {
                    "ai_score": doc_analysis.ai_score,
                    "ai_status": doc_analysis.ai_status,
                    "detected_features": doc_analysis.detected_features_list,
                    "missing_requirements": doc_analysis.missing_requirements_list,
                    "shap_analysis": doc_analysis.shap_analysis
                }
            })

        except Exception as e:
            return jsonify({"error": safe_error_message(e, public="Preview failed.")}), 500

    @app.route("/api/ipo-analyze", methods=["POST"])
    def api_ipo_analyze():
        """Handle file upload and AI analysis for IPOPHL documents."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        try:
            # Import AI engine
            from machinelearning.ai_engine import gi_analyzer

            # Check if file was uploaded
            if 'file' not in request.files:
                return jsonify({"error": "No file provided"}), 400

            file = request.files['file']
            if file.filename == '':
                return jsonify({"error": "No file selected"}), 400

            ok_name, name_err, file_ext = validate_filename_extension(file.filename)
            if not ok_name:
                return api_error(name_err, 400)

            ipophl_phase = validate_enum(
                request.form.get("phase", "unknown"), IPOPHL_PHASES, "unknown"
            )
            task_id = secure_filename((request.form.get("task_id") or "unknown")[:64])

            raw_path = gi_analyzer.save_uploaded_file(file, file.filename)
            file_path_obj = Path(raw_path)
            file_path = file_path_obj.as_posix()
            file_size = file_path_obj.stat().st_size
            max_mb = MAX_UPLOAD_BYTES // (1024 * 1024)
            if file_size > MAX_UPLOAD_BYTES:
                try:
                    file_path_obj.unlink(missing_ok=True)
                except OSError:
                    pass
                return api_error(f"File too large. Maximum size is {max_mb} MB.", 400)

            analysis_result = gi_analyzer.analyze_document(str(file_path_obj), task_id=task_id)

            if not analysis_result.get('success', False):
                return jsonify({
                    "success": False,
                    "error": analysis_result.get('error', 'Analysis failed'),
                    "message": analysis_result.get('error', 'Analysis failed'),
                }), 500

            file_uuid = file_path_obj.stem
            analysis_payload = _analysis_payload_from_result(analysis_result)
            user_phone = (get_current_user_phone() or "").strip()

            ipophl_store.upsert(
                _store_record_from_upload(
                    file_uuid=file_uuid,
                    filename=file.filename,
                    file_path=file_path,
                    file_ext=file_ext,
                    file_size=file_size,
                    ipophl_phase=ipophl_phase,
                    task_id=task_id,
                    analysis_payload=analysis_payload,
                    uploaded_by=user_phone,
                )
            )

            db_saved = False
            db_warning = None
            try:
                existing_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
                if existing_analysis:
                    doc_analysis = existing_analysis
                else:
                    doc_analysis = DocumentAnalysis(
                        file_uuid=file_uuid,
                        original_filename=secure_filename(file.filename),
                        file_path=file_path,
                        file_type=file_ext,
                        file_size=file_size,
                        ipophl_phase=ipophl_phase,
                        task_id=task_id,
                    )

                doc_analysis.ai_score = analysis_payload["readiness_score"]
                doc_analysis.ai_status = analysis_payload["status"]
                doc_analysis.set_detected_features(analysis_payload["detected_features"])
                doc_analysis.set_missing_requirements(analysis_payload["missing_requirements"])
                doc_analysis.analysis_method = analysis_payload["analysis_method"]
                doc_analysis.text_length = analysis_payload["text_length"]
                doc_analysis.shap_analysis = analysis_payload["shap_analysis"]
                doc_analysis.analysis_timestamp = datetime.utcnow()

                if existing_analysis:
                    db.session.commit()
                else:
                    db.session.add(doc_analysis)
                    db.session.commit()

                db_saved = True
            except Exception as db_exc:
                db.session.rollback()
                db_warning = safe_error_message(
                    db_exc,
                    public="Analysis finished but could not be saved to the database. Check connection settings in settings.json.",
                )

            if db_saved:
                try:
                    log_activity(
                        user_phone,
                        "IPOPHL_DOCUMENT_ANALYZED",
                        f"Analyzed {file.filename} - Score: {analysis_payload['readiness_score']}%",
                        request.remote_addr,
                    )
                except Exception:
                    pass

            response_body = {
                "success": True,
                "file_uuid": file_uuid,
                "filename": file.filename,
                "file_size": file_size,
                "analysis": analysis_payload,
                "preview_url": gi_analyzer.get_file_preview_url(file_path),
                "ipophl_phase": ipophl_phase,
                "task_id": task_id,
                "db_saved": db_saved,
            }
            if db_warning:
                response_body["warning"] = db_warning
            return jsonify(response_body)

        except Exception as e:
            return jsonify({"error": safe_error_message(e, public="Analysis failed.")}), 500

    def _delete_ipo_document(file_uuid: str):
        file_uuid = unquote((file_uuid or "").strip())
        guard = _guard_uuid(file_uuid)
        if guard:
            return guard

        try:
            record = _resolve_local_record(file_uuid)
            removed = _remove_ipo_files_from_disk(file_uuid, record)
            ipophl_store.purge(file_uuid)

            # Best-effort DB cleanup — must not block delete when MySQL is offline
            try:
                doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
                if doc_analysis:
                    db.session.delete(doc_analysis)
                    db.session.commit()
            except Exception:
                db.session.rollback()

            try:
                log_activity(
                    get_current_user_phone(),
                    "IPOPHL_DOCUMENT_DELETED",
                    f"Deleted {record.get('original_filename', file_uuid) if record else file_uuid}",
                    request.remote_addr,
                )
            except Exception:
                pass

            return jsonify({"success": True, "removed": removed})

        except Exception as e:
            return jsonify({
                "success": False,
                "error": safe_error_message(e, public="Deletion failed."),
                "message": safe_error_message(e, public="Deletion failed."),
            }), 500

    @app.route("/api/ipo-purge-legacy", methods=["POST"])
    def api_purge_legacy_ipo_documents():
        """Remove auto-imported / legacy files (no uploaded_by) from disk and indexes."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        removed = 0
        for rec in list(ipophl_store.list_all()):
            if (rec.get("uploaded_by") or "").strip():
                continue
            file_uuid = str(rec.get("file_uuid") or "").strip()
            if not file_uuid:
                continue
            _remove_ipo_files_from_disk(file_uuid, rec)
            ipophl_store.purge(file_uuid)
            removed += 1

        return jsonify({"success": True, "removed": removed})

    @app.route("/api/ipo-delete", methods=["POST", "GET"])
    def api_delete_ipo_file_post():
        """Delete an IPOPHL document (JSON body or ?file_uuid= query)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized", "message": "Unauthorized"}), 401
        if request.method == "GET":
            file_uuid = request.args.get("file_uuid", "")
        else:
            payload = request.get_json(silent=True) or {}
            file_uuid = payload.get("file_uuid") or request.form.get("file_uuid") or ""
        return _delete_ipo_document(file_uuid)

    @app.route("/api/ipo-delete/<path:file_uuid>", methods=["DELETE"])
    def api_delete_ipo_file(file_uuid):
        """Delete an IPOPHL document by id in the URL path."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        return _delete_ipo_document(file_uuid)

    @app.route("/api/file-preview/<path:filename>")
    def api_file_preview(filename):
        """Serve file for preview."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        basename = unquote((filename or "").replace("\\", "/").split("/")[-1])
        if not basename or ".." in basename:
            return jsonify({"error": "Invalid file name."}), 400

        try:
            file_uuid = basename.rsplit(".", 1)[0] if "." in basename else basename
            ok_uuid, uuid_err = validate_document_id(file_uuid)
            if not ok_uuid:
                return jsonify({"error": uuid_err}), 400

            record = _resolve_document_record(file_uuid)
            if not record:
                return jsonify({"error": "File not found"}), 404

            file_path = Path(record["file_path"])
            if not file_path.exists():
                return jsonify({"error": "File not found on disk"}), 404

            # Determine mimetype for better browser preview
            mimetype = None
            suffix = file_path.suffix.lower()
            if suffix == '.pdf':
                mimetype = 'application/pdf'
            elif suffix == '.csv':
                mimetype = 'text/plain'
            elif suffix in ['.doc', '.docx']:
                mimetype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

            return send_file(str(file_path), as_attachment=False, mimetype=mimetype)

        except Exception as e:
            return jsonify({"error": safe_error_message(e, public="Preview failed.")}), 500

    @app.route("/api/ipo-analysis/<path:file_uuid>", methods=["GET"])
    def api_get_ipo_analysis(file_uuid):
        """Get analysis results for a specific document."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        guard = _guard_uuid(file_uuid)
        if guard:
            return guard

        try:
            record = _resolve_document_record(file_uuid)
            if not record:
                return jsonify({"error": "Document not found"}), 404

            from machinelearning.ai_engine import gi_analyzer

            file_path = record.get("file_path") or ""
            preview_url = gi_analyzer.get_file_preview_url(file_path) if file_path else ""

            return jsonify({
                "success": True,
                "file_uuid": record["file_uuid"],
                "filename": record.get("original_filename"),
                "preview_url": preview_url,
                "analysis": {
                    "readiness_score": record.get("ai_score", 0),
                    "status": record.get("ai_status", "Not Ready"),
                    "detected_features": record.get("detected_features") or [],
                    "missing_requirements": record.get("missing_requirements") or [],
                    "analysis_method": record.get("analysis_method", "rule_based"),
                    "text_length": record.get("text_length", 0),
                    "shap_analysis": record.get("shap_analysis", ""),
                    "analysis_timestamp": record.get("updated_at"),
                },
                "ipophl_phase": record.get("ipophl_phase"),
                "task_id": record.get("task_id"),
            })

        except Exception as e:
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
            # Try to find by UUID first
            doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
            
            # Fallback: Try to find by original filename if file_uuid looks like a filename
            if not doc_analysis:
                from werkzeug.utils import secure_filename
                safe_name = secure_filename(file_uuid)
                doc_analysis = DocumentAnalysis.query.filter(
                    (DocumentAnalysis.original_filename == file_uuid) | 
                    (DocumentAnalysis.original_filename == safe_name) |
                    (DocumentAnalysis.original_filename.like(f"{file_uuid}.%")) |
                    (DocumentAnalysis.original_filename.like(f"{safe_name}.%"))
                ).first()

            if not doc_analysis:
                return jsonify({"error": "Document not found"}), 404

            payload = request.get_json(silent=True) or {}
            if payload:
                return api_error(
                    "Manual analysis overrides are not allowed. Send an empty body to re-run analysis.",
                    400,
                )

            from machinelearning.ai_engine import gi_analyzer

            result = gi_analyzer.analyze_document(doc_analysis.file_path, task_id=doc_analysis.task_id)
            if result.get("success"):
                doc_analysis.ai_score = result["readiness_score"]
                doc_analysis.ai_status = result["status"]
                doc_analysis.set_detected_features(result["detected_features"])
                doc_analysis.set_missing_requirements(result["missing_requirements"])
                doc_analysis.analysis_method = result["analysis_method"]
                doc_analysis.text_length = result["text_length"]
                doc_analysis.shap_analysis = result.get("shap_analysis", "")
            else:
                return jsonify({"error": "Re-analysis failed."}), 500

            doc_analysis.analysis_timestamp = datetime.utcnow()
            db.session.commit()

            # Log activity
            user_phone = get_current_user_phone()
            log_activity(user_phone, "IPOPHL_DOCUMENT_UPDATED",
                        f"Updated analysis for {doc_analysis.original_filename}",
                        request.remote_addr)

            return jsonify({
                "success": True,
                "analysis": {
                    "readiness_score": doc_analysis.ai_score,
                    "status": doc_analysis.ai_status,
                    "detected_features": doc_analysis.detected_features_list,
                    "missing_requirements": doc_analysis.missing_requirements_list,
                    "analysis_method": doc_analysis.analysis_method,
                    "text_length": doc_analysis.text_length,
                    "shap_analysis": doc_analysis.shap_analysis
                }
            })

        except Exception as e:
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

            if request.args.get("recover_disk") == "1":
                _bootstrap_disk_uploads()

            current_user = (get_current_user_phone() or "").strip()
            merged: dict[str, dict] = {}
            for rec in ipophl_store.list_all(phase=phase, task_id=task_id):
                file_uuid = str(rec.get("file_uuid") or "").strip()
                if not file_uuid or ipophl_store.is_deleted(file_uuid):
                    continue
                if not _record_visible_to_user(rec, current_user):
                    continue
                file_path = rec.get("file_path")
                if file_path and not Path(file_path).is_file():
                    ipophl_store.purge(file_uuid)
                    continue
                merged[file_uuid] = ipophl_store.to_list_item(rec)

            try:
                query = DocumentAnalysis.query
                if phase:
                    query = query.filter(DocumentAnalysis.ipophl_phase == phase)
                if task_id:
                    query = query.filter(DocumentAnalysis.task_id == task_id)
                documents = query.order_by(DocumentAnalysis.upload_timestamp.desc()).limit(limit).all()
                for doc in documents:
                    if ipophl_store.is_deleted(doc.file_uuid):
                        continue
                    stored = ipophl_store.get(doc.file_uuid)
                    if not stored or not _record_visible_to_user(stored, current_user):
                        continue
                    merged[doc.file_uuid] = ipophl_store.to_list_item(stored)
            except Exception:
                pass

            items = sorted(
                merged.values(),
                key=lambda row: row.get("upload_timestamp") or "",
                reverse=True,
            )[:limit]

            return jsonify({"items": items, "count": len(items)})

        except Exception as e:
            return jsonify({"error": safe_error_message(e, public="Failed to list documents.")}), 500
