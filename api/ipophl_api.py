"""
IPOPHL document analysis API endpoints for Beanthentic application.

Provides endpoints for IPOPHL document upload, analysis, and retrieval.
"""

import os
from datetime import datetime
from pathlib import Path

from flask import jsonify, request, send_file
from werkzeug.utils import secure_filename

from config.models import DocumentAnalysis, db
from config.security import api_error, safe_error_message
from config.validation import (
    MAX_UPLOAD_BYTES,
    validate_enum,
    validate_filename_extension,
    validate_uuid_like,
    IPOPHL_PHASES,
)
from config.utils import get_current_user_phone, is_authenticated, log_activity


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
            task_id = secure_filename((request.form.get("task_id") or "unknown")[:64])

            # Use Path for cross-platform compatibility and normalization
            # gi_analyzer.save_uploaded_file already handles the OS-specific path joining
            raw_path = gi_analyzer.save_uploaded_file(file, file.filename)
            file_path_obj = Path(raw_path)
            
            # Normalize path for database storage (use as_posix() to always use forward slashes)
            file_path = file_path_obj.as_posix()
            
            # Perform AI analysis with task context
            # Convert back to local OS string for the actual analysis function
            analysis_result = gi_analyzer.analyze_document(str(file_path_obj), task_id=task_id)

            if not analysis_result.get('success', False):
                return jsonify({"error": analysis_result.get('error', 'Analysis failed')}), 500

            # Save analysis to database
            file_uuid = file_path_obj.stem  # UUID without extension

            # Check if analysis already exists
            existing_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
            if existing_analysis:
                # Update existing record
                doc_analysis = existing_analysis
            else:
                # Create new record
                doc_analysis = DocumentAnalysis(
                    file_uuid=file_uuid,
                    original_filename=secure_filename(file.filename),
                    file_path=file_path,
                    file_type=file_ext,
                    file_size=os.path.getsize(str(file_path_obj)),
                    ipophl_phase=ipophl_phase,
                    task_id=task_id
                )

            # Update analysis results
            doc_analysis.ai_score = analysis_result.get('readiness_score', 0)
            doc_analysis.ai_status = analysis_result.get('status', 'Not Ready')
            doc_analysis.set_detected_features(analysis_result.get('detected_features', []))
            doc_analysis.set_missing_requirements(analysis_result.get('missing_requirements', []))
            doc_analysis.analysis_method = analysis_result.get('analysis_method', 'rule_based')
            doc_analysis.text_length = analysis_result.get('text_length', 0)
            doc_analysis.shap_analysis = analysis_result.get('shap_analysis', "")
            doc_analysis.analysis_timestamp = datetime.utcnow()

            # Save to database
            if existing_analysis:
                db.session.commit()
            else:
                db.session.add(doc_analysis)
                db.session.commit()

            # Log activity
            user_phone = get_current_user_phone()
            log_activity(user_phone, "IPOPHL_DOCUMENT_ANALYZED",
                        f"Analyzed {file.filename} - Score: {doc_analysis.ai_score}%",
                        request.remote_addr)

            # Return analysis results
            return jsonify({
                "success": True,
                "file_uuid": file_uuid,
                "filename": file.filename,
                "analysis": {
                    "readiness_score": doc_analysis.ai_score,
                    "status": doc_analysis.ai_status,
                    "detected_features": doc_analysis.detected_features_list,
                    "missing_requirements": doc_analysis.missing_requirements_list,
                    "analysis_method": doc_analysis.analysis_method,
                    "text_length": doc_analysis.text_length,
                    "shap_analysis": doc_analysis.shap_analysis
                },
                "preview_url": gi_analyzer.get_file_preview_url(file_path),
                "ipophl_phase": ipophl_phase,
                "task_id": task_id
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
            doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()
            if not doc_analysis:
                return jsonify({"error": "Document not found"}), 404

            # Remove from disk
            if os.path.exists(doc_analysis.file_path):
                os.remove(doc_analysis.file_path)

            # Remove from database
            db.session.delete(doc_analysis)
            db.session.commit()

            # Log activity
            user_phone = get_current_user_phone()
            log_activity(user_phone, "IPOPHL_DOCUMENT_DELETED",
                        f"Deleted {doc_analysis.original_filename}",
                        request.remote_addr)

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
            doc_analysis = DocumentAnalysis.query.filter_by(file_uuid=file_uuid).first()

            # Fallback: Search by original_filename or secure version
            if not doc_analysis:
                from werkzeug.utils import secure_filename
                safe_name = secure_filename(file_uuid)
                doc_analysis = DocumentAnalysis.query.filter(
                    (DocumentAnalysis.original_filename == filename) |
                    (DocumentAnalysis.original_filename == file_uuid) |
                    (DocumentAnalysis.original_filename == safe_name) |
                    (DocumentAnalysis.original_filename.like(f"{file_uuid}.%")) |
                    (DocumentAnalysis.original_filename.like(f"{safe_name}.%"))
                ).first()

            if not doc_analysis:
                return jsonify({"error": "File not found"}), 404

            # Use Path to handle the stored posix path on any OS (Windows/macOS)
            file_path = Path(doc_analysis.file_path)
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

    @app.route("/api/ipo-analysis/<file_uuid>", methods=["GET"])
    def api_get_ipo_analysis(file_uuid):
        """Get analysis results for a specific document."""
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
                
                # Search by original_filename, secure version, or prefix
                doc_analysis = DocumentAnalysis.query.filter(
                    (DocumentAnalysis.original_filename == file_uuid) | 
                    (DocumentAnalysis.original_filename == safe_name) |
                    (DocumentAnalysis.original_filename.like(f"{file_uuid}.%")) |
                    (DocumentAnalysis.original_filename.like(f"{safe_name}.%"))
                ).first()

            if not doc_analysis:
                return jsonify({"error": "Document not found"}), 404

            return jsonify({
                "success": True,
                "file_uuid": doc_analysis.file_uuid,
                "filename": doc_analysis.original_filename,
                "analysis": {
                    "readiness_score": doc_analysis.ai_score,
                    "status": doc_analysis.ai_status,
                    "detected_features": doc_analysis.detected_features_list,
                    "missing_requirements": doc_analysis.missing_requirements_list,
                    "analysis_method": doc_analysis.analysis_method,
                    "text_length": doc_analysis.text_length,
                    "shap_analysis": doc_analysis.shap_analysis,
                    "analysis_timestamp": doc_analysis.analysis_timestamp.isoformat() if doc_analysis.analysis_timestamp else None
                },
                "ipophl_phase": doc_analysis.ipophl_phase,
                "task_id": doc_analysis.task_id
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

            query = DocumentAnalysis.query
            if phase:
                query = query.filter(DocumentAnalysis.ipophl_phase == phase)
            if task_id:
                query = query.filter(DocumentAnalysis.task_id == task_id)

            documents = query.order_by(DocumentAnalysis.upload_timestamp.desc()).limit(limit).all()

            items = []
            for doc in documents:
                items.append({
                    "file_uuid": doc.file_uuid,
                    "filename": doc.original_filename,
                    "file_type": doc.file_type,
                    "file_size": doc.file_size,
                    "upload_timestamp": doc.upload_timestamp.isoformat(),
                    "ai_score": doc.ai_score,
                    "ai_status": doc.ai_status,
                    "ipophl_phase": doc.ipophl_phase,
                    "task_id": doc.task_id
                })

            return jsonify({"items": items, "count": len(items)})

        except Exception as e:
            return jsonify({"error": safe_error_message(e, public="Failed to list documents.")}), 500
