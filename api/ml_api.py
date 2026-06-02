"""Machine learning API — farmer GI readiness predictions."""

from __future__ import annotations

from flask import jsonify, request

from config.security import require_admin, safe_error_message
from config.utils import get_current_user_phone, is_authenticated, log_activity


def register_ml_routes(app):
    """Register ML prediction routes."""

    @app.route("/api/ml/status", methods=["GET"])
    def api_ml_status():
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401
        try:
            from machinelearning.ai_engine import gi_analyzer

            return jsonify({"success": True, **gi_analyzer.ml_status()})
        except Exception as e:
            return jsonify({"success": False, "error": safe_error_message(e)}), 500

    @app.route("/api/ml/farmer-readiness", methods=["POST"])
    def api_ml_farmer_readiness():
        """Predict GI readiness for one or many farmer rows (dashboard shape)."""
        if not is_authenticated():
            return jsonify({"error": "Unauthorized"}), 401

        try:
            from machinelearning.ai_engine import gi_analyzer
            from machinelearning.farmer_features import farmer_row_to_ml_features

            payload = request.get_json(silent=True) or {}
            rows = payload.get("farmers")
            if rows is None and isinstance(payload, dict) and payload.get("farmer_id") is not None:
                rows = [payload]
            if not isinstance(rows, list) or not rows:
                return jsonify({"error": "Provide a non-empty 'farmers' array."}), 400

            if len(rows) == 1:
                features = farmer_row_to_ml_features(rows[0])
                result = gi_analyzer.analyze_farmer_profile(features)
                if not result.get("success"):
                    return jsonify(result), 503
                return jsonify({"success": True, "prediction": result})

            batch = gi_analyzer.predict_farmers_batch(rows)
            if not batch.get("success"):
                return jsonify(batch), 503
            return jsonify(batch)
        except Exception as e:
            return jsonify({"success": False, "error": safe_error_message(e)}), 500

    @app.route("/api/ml/train", methods=["POST"])
    @require_admin
    def api_ml_train():
        """Retrain farmer GI model from CSV (admin only)."""
        try:
            import subprocess
            import sys
            from pathlib import Path

            script = Path(__file__).resolve().parents[1] / "machinelearning" / "train_ai_model.py"
            proc = subprocess.run(
                [sys.executable, str(script), "--full-pipeline"],
                capture_output=True,
                text=True,
                cwd=str(script.parent),
                timeout=600,
            )
            if proc.returncode != 0:
                return jsonify(
                    {
                        "success": False,
                        "error": "Training failed.",
                        "detail": (proc.stderr or proc.stdout or "")[-2000:],
                    }
                ), 500

            import machinelearning.ai_engine as engine_mod

            engine_mod.gi_analyzer._initialize_models()

            user_phone = get_current_user_phone()
            log_activity(
                user_phone,
                "ML_MODEL_TRAINED",
                "Farmer and document GI models retrained",
                request.remote_addr,
            )

            return jsonify(
                {
                    "success": True,
                    "message": "Model trained successfully.",
                    "status": engine_mod.gi_analyzer.ml_status(),
                    "log": (proc.stdout or "")[-1500:],
                }
            )
        except Exception as e:
            return jsonify({"success": False, "error": safe_error_message(e)}), 500
