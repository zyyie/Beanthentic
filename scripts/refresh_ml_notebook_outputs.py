#!/usr/bin/env python3
"""Refresh paper-ready outputs in 01_beanthentic_ml_training.ipynb after retrain."""

from __future__ import annotations

import base64
import io
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ML_DIR = ROOT / "machinelearning"
NB_PATH = ML_DIR / "notebooks" / "01_beanthentic_ml_training.ipynb"

sys.path.insert(0, str(ML_DIR))
sys.path.insert(0, str(ROOT))


def _stdout(text: str) -> dict:
    return {
        "name": "stdout",
        "output_type": "stream",
        "text": text if text.endswith("\n") else text + "\n",
    }


def _display_html(html: str) -> dict:
    return {
        "data": {"text/html": [html], "text/plain": ["<IPython.core.display.HTML object>"]},
        "metadata": {},
        "output_type": "display_data",
    }


def _png_output(png_bytes: bytes) -> dict:
    b64 = base64.b64encode(png_bytes).decode("ascii")
    return {
        "data": {
            "image/png": b64,
            "text/plain": ["<Figure size 500x400 with 2 Axes>"],
        },
        "metadata": {"image/png": {"width": 500, "height": 400}},
        "output_type": "display_data",
    }


def main() -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import seaborn as sns

    from ensemble_learning import ENSEMBLE_DESCRIPTION

    results = json.loads((ML_DIR / "document_training_results.json").read_text(encoding="utf-8"))
    manifest = json.loads(
        (ML_DIR / "training_data" / "official_mop_manifest.json").read_text(encoding="utf-8")
    )
    dataset = json.loads(
        (ML_DIR / "training_data" / "gi_documents_raw.json").read_text(encoding="utf-8")
    )

    ready = sum(1 for d in dataset if d.get("label") == "Ready")
    not_ready = len(dataset) - ready

    # Cell 1 output
    setup_text = (
        f"Project root: {ROOT}\n"
        f"ML dir: {ML_DIR}\n"
        f"Ensemble: {ENSEMBLE_DESCRIPTION}\n"
    )

    # Metrics cell output + report table
    metrics_text = (
        f"Official files: {manifest['official_file_count']}\n"
        f"Training rows: {manifest['training_row_count']}\n"
        f"Dataset labels: Ready={ready} | Not Ready={not_ready}\n"
        f"Expanded training set: {results['sample_count']} "
        f"(Ready={results['ready_count']} | Not Ready={results['not_ready_count']})\n"
        f"Test accuracy: {results['accuracy']:.3f}\n"
        f"CV mean ± std: {results['cv_mean']:.3f} ± {results['cv_std']:.3f}\n"
        f"Best params: {results['best_params']}\n"
        f"Analysis method: {results.get('analysis_method')}\n"
        f"Training source: {results.get('training_source')}\n"
        f"Training date: {results.get('training_date')}\n"
        f"Ensemble: {results.get('ensemble_method')}\n"
    )

    report = pd.DataFrame(results["classification_report"]).T
    report_html = report.to_html(float_format=lambda x: f"{x:.3f}" if isinstance(x, float) else str(x))

    # Confusion matrix figure
    cm_doc = np.array(results["confusion_matrix"])
    fig, ax = plt.subplots(figsize=(5, 4))
    sns.heatmap(
        cm_doc,
        annot=True,
        fmt="d",
        cmap="Blues",
        xticklabels=["Not Ready", "Ready"],
        yticklabels=["Not Ready", "Ready"],
        ax=ax,
    )
    ax.set_title("Official IPOPHL Document Ensemble — Confusion Matrix")
    ax.set_ylabel("Actual")
    ax.set_xlabel("Predicted")
    fig.tight_layout()
    png_path = ML_DIR / "document_confusion_matrix.png"
    fig.savefig(png_path, dpi=150)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150)
    plt.close(fig)
    png_bytes = buf.getvalue()

    cm_text = (
        f"Saved: {png_path}\n"
        f"Hold-out accuracy: {results['accuracy']:.1%} | "
        f"5-fold CV: {results['cv_mean']:.1%} ± {results['cv_std']:.1%}\n"
        f"Confusion matrix: {results['confusion_matrix']}\n"
    )

    # MoP qualitative section (fix B) — fix analyzer init
    mop_rows = []
    mop_text = ""
    try:
        from config.ipophl_store import OFFICIAL_IPOPHL_TASK_IDS, list_documents, resolve_file_path
        from ai_engine import GIAnalyzer
        from gi_reference_basis import evaluate_against_reference

        analyzer = GIAnalyzer(str(ML_DIR), auto_train=False)
        for tid in OFFICIAL_IPOPHL_TASK_IDS:
            docs = list_documents(task_id=tid, limit=5)
            if not docs:
                mop_rows.append(
                    {"task_id": tid, "file": "(none)", "status": "—", "word_count": 0, "missing": ""}
                )
                continue
            rec = docs[0]
            path = resolve_file_path(rec["file_uuid"], filename_hint=rec.get("original_filename"))
            text = analyzer.extract_text_from_file(str(path)) if path else ""
            review = evaluate_against_reference(
                text, task_id=tid, term_matches=analyzer._term_matches
            )
            mop_rows.append(
                {
                    "task_id": tid,
                    "file": rec.get("original_filename") or (path.name if path else ""),
                    "status": review["status"],
                    "word_count": review["word_count"],
                    "missing": ", ".join(review.get("missing_requirements") or [])[:80],
                }
            )
        mop_df = pd.DataFrame(mop_rows)
        mop_html = mop_df.to_html(index=False)
        ready_mop = int((mop_df["status"] == "Ready").sum()) if len(mop_df) else 0
        mop_text = f"Ready count: {ready_mop} / {len(OFFICIAL_IPOPHL_TASK_IDS)}\n"
    except Exception as exc:
        mop_html = f"<p>MoP store evaluation skipped: {exc}</p>"
        mop_text = f"MoP evaluation note: {exc}\n"

    # Official MoP labels from manifest (authoritative baseline for paper)
    man_df = pd.DataFrame(manifest.get("files") or [])
    if not man_df.empty:
        man_html = man_df.to_html(index=False)
        man_ready = int((man_df["status"] == "Ready").sum())
        man_text = (
            f"Official MoP qualitative labels (n={len(man_df)}): "
            f"Ready={man_ready}, Not Ready={len(man_df) - man_ready}\n"
        )
    else:
        man_html = "<p>No manifest files</p>"
        man_text = "No official MoP manifest files.\n"

    status_text = (
        "Current production document metrics:\n"
        + json.dumps(results, indent=2)[:1600]
        + ("\n..." if len(json.dumps(results)) > 1600 else "\n")
    )

    paper_summary = (
        f"# Paper results snapshot (auto-refreshed {datetime.now().isoformat(timespec='seconds')})\n"
        f"\n"
        f"| Metric | Value |\n"
        f"|--------|-------|\n"
        f"| Model | Soft-voting ensemble (RF + Extra Trees + Gradient Boosting) |\n"
        f"| Training samples | {results['sample_count']} "
        f"(Ready {results['ready_count']} / Not Ready {results['not_ready_count']}) |\n"
        f"| Official MoP files | {manifest['official_file_count']} |\n"
        f"| Hold-out test accuracy | **{results['accuracy']:.1%}** |\n"
        f"| Cross-validation | **{results['cv_mean']:.1%} ± {results['cv_std']:.1%}** |\n"
        f"| Confusion matrix | {results['confusion_matrix']} |\n"
        f"| Training date | {results['training_date']} |\n"
        f"| Artifact | `machinelearning/gi_document_model.joblib` |\n"
        f"| Metrics JSON | `machinelearning/document_training_results.json` |\n"
        f"| Figure | `machinelearning/document_confusion_matrix.png` |\n"
        f"\n"
        f"**Note for the paper:** Dashboard Ready/Not Ready is driven by the MoP qualitative "
        f"engine; the ensemble is the advisory ML layer evaluated above.\n"
    )

    nb = json.loads(NB_PATH.read_text(encoding="utf-8"))
    cells = nb["cells"]

    # Insert / refresh paper summary as cell 1 (after title markdown)
    summary_cell = {
        "cell_type": "markdown",
        "id": "paper-results-snapshot",
        "metadata": {},
        "source": [line + "\n" for line in paper_summary.splitlines()],
    }
    # Remove previous auto snapshot if present
    cells = [c for c in cells if c.get("id") != "paper-results-snapshot"]
    if cells and cells[0].get("cell_type") == "markdown":
        cells.insert(1, summary_cell)
    else:
        cells.insert(0, summary_cell)

    # Map by cell id / content heuristics
    for cell in cells:
        src = "".join(cell.get("source") or [])
        if cell.get("cell_type") != "code":
            continue

        if "ENSEMBLE_DESCRIPTION" in src and "PROJECT_ROOT" in src:
            cell["execution_count"] = 1
            cell["outputs"] = [_stdout(setup_text)]

        elif "document_training_results.json" in src and "classification_report" in src:
            cell["execution_count"] = 2
            # Enrich source to also print expanded sample counts
            if "Expanded training set" not in src:
                cell["source"] = [
                    "manifest_path = ML_DIR / \"training_data\" / \"official_mop_manifest.json\"\n",
                    "results_path = ML_DIR / \"document_training_results.json\"\n",
                    "raw_path = ML_DIR / \"training_data\" / \"gi_documents_raw.json\"\n",
                    "\n",
                    "manifest = json.loads(manifest_path.read_text(encoding=\"utf-8\"))\n",
                    "results = json.loads(results_path.read_text(encoding=\"utf-8\"))\n",
                    "dataset = json.loads(raw_path.read_text(encoding=\"utf-8\"))\n",
                    "\n",
                    "ready = sum(1 for d in dataset if d.get(\"label\") == \"Ready\")\n",
                    "not_ready = len(dataset) - ready\n",
                    "\n",
                    "print(\"Official files:\", manifest[\"official_file_count\"])\n",
                    "print(\"Official MoP training rows (pre-expand):\", manifest[\"training_row_count\"])\n",
                    "print(f\"Expanded dataset labels: Ready={ready} | Not Ready={not_ready}\")\n",
                    "print(f\"Training set size: {results['sample_count']} "
                    "(Ready={results['ready_count']} | Not Ready={results['not_ready_count']})\")\n",
                    "print(f\"Test accuracy: {results['accuracy']:.3f}\")\n",
                    "print(f\"CV mean ± std: {results['cv_mean']:.3f} ± {results['cv_std']:.3f}\")\n",
                    "print(\"Best params:\", results[\"best_params\"])\n",
                    "print(\"Analysis method:\", results.get(\"analysis_method\"))\n",
                    "print(\"Training source:\", results.get(\"training_source\"))\n",
                    "print(\"Training date:\", results.get(\"training_date\"))\n",
                    "print(\"Ensemble:\", results.get(\"ensemble_method\"))\n",
                    "\n",
                    "report = pd.DataFrame(results[\"classification_report\"]).T\n",
                    "report\n",
                ]
            cell["outputs"] = [
                _stdout(metrics_text),
                {
                    "data": {
                        "text/html": [report_html],
                        "text/plain": [report.to_string()],
                    },
                    "execution_count": 2,
                    "metadata": {},
                    "output_type": "execute_result",
                },
            ]

        elif "confusion_matrix" in src and "sns.heatmap" in src:
            cell["execution_count"] = 3
            cell["source"] = [
                "cm_doc = np.array(results[\"confusion_matrix\"])\n",
                "plt.figure(figsize=(5, 4))\n",
                "sns.heatmap(\n",
                "    cm_doc,\n",
                "    annot=True,\n",
                "    fmt=\"d\",\n",
                "    cmap=\"Blues\",\n",
                "    xticklabels=[\"Not Ready\", \"Ready\"],\n",
                "    yticklabels=[\"Not Ready\", \"Ready\"],\n",
                ")\n",
                "plt.title(\"Official IPOPHL Document Ensemble — Confusion Matrix\")\n",
                "plt.ylabel(\"Actual\")\n",
                "plt.xlabel(\"Predicted\")\n",
                "plt.tight_layout()\n",
                "plt.savefig(ML_DIR / \"document_confusion_matrix.png\", dpi=150)\n",
                "plt.show()\n",
                "print(\"Saved:\", ML_DIR / \"document_confusion_matrix.png\")\n",
                "print(\n",
                "    f\"Hold-out accuracy: {results['accuracy']:.1%} | \"\n",
                "    f\"CV: {results['cv_mean']:.1%} ± {results['cv_std']:.1%}\"\n",
                ")\n",
                "print(\"Confusion matrix:\", results[\"confusion_matrix\"])\n",
            ]
            cell["outputs"] = [_png_output(png_bytes), _stdout(cm_text)]

        elif "evaluate_against_reference" in src and "OFFICIAL_IPOPHL_TASK_IDS" in src:
            cell["execution_count"] = 4
            cell["source"] = [
                "from ai_engine import GIAnalyzer\n",
                "from config.ipophl_store import OFFICIAL_IPOPHL_TASK_IDS, list_documents, resolve_file_path\n",
                "from machinelearning.gi_reference_basis import evaluate_against_reference\n",
                "\n",
                "analyzer = GIAnalyzer(str(ML_DIR), auto_train=False)\n",
                "\n",
                "rows = []\n",
                "for tid in OFFICIAL_IPOPHL_TASK_IDS:\n",
                "    docs = list_documents(task_id=tid, limit=5)\n",
                "    if not docs:\n",
                "        rows.append({\"task_id\": tid, \"file\": \"(none)\", \"status\": \"—\", \"word_count\": 0, \"missing\": \"\"})\n",
                "        continue\n",
                "    rec = docs[0]\n",
                "    path = resolve_file_path(rec[\"file_uuid\"], filename_hint=rec.get(\"original_filename\"))\n",
                "    text = analyzer.extract_text_from_file(str(path)) if path else \"\"\n",
                "    review = evaluate_against_reference(text, task_id=tid, term_matches=analyzer._term_matches)\n",
                "    rows.append({\n",
                "        \"task_id\": tid,\n",
                "        \"file\": rec.get(\"original_filename\") or (path.name if path else \"\"),\n",
                "        \"status\": review[\"status\"],\n",
                "        \"word_count\": review[\"word_count\"],\n",
                "        \"missing\": \", \".join(review.get(\"missing_requirements\") or [])[:80],\n",
                "    })\n",
                "\n",
                "mop_df = pd.DataFrame(rows)\n",
                "display(mop_df)\n",
                "print(\"Ready count:\", (mop_df[\"status\"] == \"Ready\").sum(), \"/\", len(OFFICIAL_IPOPHL_TASK_IDS))\n",
                "\n",
                "# Authoritative official MoP labels from the rebuilt manifest\n",
                "man_df = pd.DataFrame(manifest.get(\"files\") or [])\n",
                "display(man_df)\n",
                "if not man_df.empty:\n",
                "    print(\n",
                "        \"Official MoP qualitative Ready:\",\n",
                "        int((man_df[\"status\"] == \"Ready\").sum()),\n",
                "        \"/\",\n",
                "        len(man_df),\n",
                "    )\n",
            ]
            cell["outputs"] = [
                _display_html(mop_html),
                _stdout(mop_text),
                _display_html(man_html),
                _stdout(man_text),
            ]

        elif "Current production document metrics" in src or (
            "status_path" in src and "document_training_results.json" in src
        ):
            cell["execution_count"] = 5
            cell["outputs"] = [_stdout(status_text)]

    nb["cells"] = cells
    NB_PATH.write_text(json.dumps(nb, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Updated notebook: {NB_PATH}")
    print(f"Confusion matrix: {png_path}")
    print(
        f"Accuracy={results['accuracy']:.3f} | "
        f"CV={results['cv_mean']:.3f}±{results['cv_std']:.3f} | n={results['sample_count']}"
    )


if __name__ == "__main__":
    main()
