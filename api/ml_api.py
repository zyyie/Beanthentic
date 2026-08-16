"""Machine learning API — GI document analysis status and retraining."""

from __future__ import annotations

import threading
from flask import jsonify, request

from config.security import require_admin, safe_error_message
from config.utils import get_current_user_phone, is_authenticated, log_activity

_TRAIN_LOCK = threading.Lock()
_TRAIN_STATE: dict = {
    "running": False,
    "success": None,
    "message": "",
    "detail": "",
    "log": "",
    "started_at": None,
    "finished_at": None,
}


def _run_document_training(user_phone: str, remote_addr: str | None) -> None:
    import subprocess
    import sys
    from datetime import datetime, timezone
    from pathlib import Path

    try:
        script = Path(__file__).resolve().parents[1] / "machinelearning" / "train_ai_model.py"
        proc = subprocess.run(
            [sys.executable, str(script), "--train-documents"],
            capture_output=True,
            text=True,
            cwd=str(script.parent),
            timeout=600,
        )
        if proc.returncode != 0:
            with _TRAIN_LOCK:
                _TRAIN_STATE.update(
                    {
                        "running": False,
                        "success": False,
                        "message": "Training failed.",
                        "detail": (proc.stderr or proc.stdout or "")[-2000:],
                        "log": (proc.stdout or "")[-1500:],
                        "finished_at": datetime.now(timezone.utc).isoformat(),
                    }
                )
            return

        import machinelearning.ai_engine as engine_mod

        engine_mod.gi_analyzer._initialize_models()
        try:
            log_activity(user_phone, "ML_MODEL_TRAINED", "GI document model retrained", remote_addr)
        except Exception:
            pass
        with _TRAIN_LOCK:
            _TRAIN_STATE.update(
                {
                    "running": False,
                    "success": True,
                    "message": "Document model trained successfully.",
                    "detail": "",
                    "log": (proc.stdout or "")[-1500:],
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "status": engine_mod.gi_analyzer.ml_status(),
                }
            )
    except Exception as exc:
        with _TRAIN_LOCK:
            _TRAIN_STATE.update(
                {
                    "running": False,
                    "success": False,
                    "message": safe_error_message(exc),
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                }
            )


def register_ml_routes(app):
    """Register ML status / document-train routes."""

    @app.route("/api/ml/status", methods=["GET"])
    @require_admin
    def api_ml_status():
        try:
            from machinelearning.ai_engine import gi_analyzer

            with _TRAIN_LOCK:
                training = {
                    "running": bool(_TRAIN_STATE.get("running")),
                    "success": _TRAIN_STATE.get("success"),
                    "message": _TRAIN_STATE.get("message") or "",
                }
            return jsonify({"success": True, **gi_analyzer.ml_status(), "training_job": training})
        except Exception as e:
            return jsonify({"success": False, "error": safe_error_message(e)}), 500

    @app.route("/api/ml/train/status", methods=["GET"])
    @require_admin
    def api_ml_train_status():
        with _TRAIN_LOCK:
            return jsonify({"ok": True, **_TRAIN_STATE})

    @app.route("/api/ml/train", methods=["POST"])
    @require_admin
    def api_ml_train():
        """Start GI document ensemble retrain in the background (admin only)."""
        from datetime import datetime, timezone

        with _TRAIN_LOCK:
            if _TRAIN_STATE.get("running"):
                return jsonify(
                    {
                        "success": True,
                        "started": False,
                        "running": True,
                        "message": "Training is already in progress. Poll /api/ml/train/status.",
                    }
                )
            _TRAIN_STATE.update(
                {
                    "running": True,
                    "success": None,
                    "message": "Training started.",
                    "detail": "",
                    "log": "",
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "finished_at": None,
                    "status": None,
                }
            )

        user_phone = get_current_user_phone()
        remote_addr = request.remote_addr
        thread = threading.Thread(
            target=_run_document_training,
            args=(user_phone, remote_addr),
            daemon=True,
        )
        thread.start()
        return jsonify(
            {
                "success": True,
                "started": True,
                "running": True,
                "message": "Training started in the background. Poll /api/ml/train/status until finished.",
            }
        )
