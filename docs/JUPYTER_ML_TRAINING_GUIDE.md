# Beanthentic AI Training Guide (Jupyter Notebook + Capstone Documentation)

This guide explains how to train, evaluate, and improve the machine learning components of **Beanthentic** using **Jupyter Notebook**, for capstone papers and technical documentation.

---

## 1. What you are training (document ensemble + MoP engine)

| Component | File / output | Purpose |
|-----------|---------------|---------|
| **Document ensemble** | `machinelearning/gi_document_model.joblib` | Advisory Ready / Not Ready from document text (bagging + boosting soft vote) |
| **MoP qualitative review** | `machinelearning/gi_reference_basis.py` | **Authoritative** IPOPHL card status on the dashboard (theme coverage) |

**Important for your paper:** On the live IPOPHL dashboard, **Ready / Not Ready** comes from the **MoP qualitative engine**, not from the ensemble score alone. The document ensemble is a **hybrid / advisory** layer.

---

## 2. Software you need

| Software | Version | Use |
|----------|---------|-----|
| Python | 3.11+ | Runtime |
| Jupyter Notebook or JupyterLab | latest | Interactive training & charts |
| VS Code / Cursor | optional | Can open `.ipynb` notebooks directly |
| Git | optional | Version-control datasets and results |

### One-time setup (from project root)

```powershell
cd "C:\Users\...\Beanthentic"
python -m venv .venv
.\.venv\Scripts\activate
pip install -r config\requirements.txt
pip install jupyter seaborn
python -m jupyter notebook
```

In Jupyter: **File → Open** → `machinelearning/notebooks/01_beanthentic_ml_training.ipynb`

**Windows note:** If `jupyter` is not recognized, use `python -m jupyter notebook` instead of `jupyter notebook`. The `jupyter` command only works after install **and** when your virtual environment is activated.

---

## 3. Step-by-step: train in Jupyter Notebook

### Step 1 — Open the notebook and set the project root

1. Start Jupyter from the **Beanthentic** folder (not from inside `machinelearning/`).
2. Open `machinelearning/notebooks/01_beanthentic_ml_training.ipynb`.
3. Run **Cell 1** (imports + `PROJECT_ROOT`). All paths depend on this.

### Step 2 — Document ensemble (IPOPHL text)

**Data source:** official MoP dataset / `machinelearning/training_data/`

1. In the notebook, run **Section A — Document** cells (metrics + confusion matrix).
2. **Deploy model to the app:**

   ```powershell
   python machinelearning\train_ai_model.py --train-documents
   ```

3. **Capstone artifacts to screenshot/export:**
   - Test accuracy, CV mean ± std
   - Confusion matrix figure
   - `machinelearning/document_training_results.json`

### Step 3 — MoP qualitative engine

1. Run **Section B** cells to evaluate MoP Ready / Not Ready on sample or stored uploads.
2. Remember: MoP status is authoritative on the IPOPHL cards; ensemble is advisory.
   Or:

   ```powershell
   cd machinelearning
   python train_ai_model.py --train-documents
   ```

5. **Capstone artifacts:**
   - `machinelearning/document_training_results.json`
   - Confusion matrix + classification report in the notebook
   - Note sample count, Ready vs Not Ready balance

### Step 4 — MoP qualitative evaluation (current IPOPHL workflow)

This is what admins see on document cards today.

1. Run **Section C** in the notebook.
2. For each uploaded MoP file, the notebook calls `evaluate_against_reference()` with the correct `task_id`.
3. Export a table: `task_id | expected | predicted | match`.
4. Compute accuracy for your **7 official zones** (and any negatives you add).

### Step 5 — Verify the live app uses the new model

1. Restart the server:

   ```powershell
   python web.py
   ```

2. Log in → open dashboard → check analytics or run:

   ```powershell
   python scripts\verify_document_ml.py
   ```

3. `GET /api/ml/status` (while logged in) should show `document_model_loaded: true` and training metadata.

---

## 4. How to add your own training data (improve accuracy)

### A. Document text (Random Forest)

Edit or append to `machinelearning/training_data/gi_documents_raw.json`. Each row:

```json
{
  "text": "Full extracted text of the document...",
  "label": "Ready",
  "task_id": "phase1-introduction",
  "score": 100,
  "source": "real_upload",
  "notes": "LGU-reviewed complete MoP section"
}
```

**Labels:** `"Ready"` or `"Not Ready"` only.

**Best practices for capstone:**

- Include all **7 MoP zones** (`phase1-introduction` … `phase3-control`).
- Add **hard negatives** (cafe menu, blank file, wrong document type).
- Aim for **50–100 real** LGU-reviewed samples if possible (strongest validation).
- Keep class balance reasonable (`class_weight="balanced"` helps, but real diversity matters more).

### B. MoP themes (rule engine — highest impact for IPOPHL UI)

Edit `machinelearning/gi_reference_basis.py`:

- `REFERENCE_THEMES` — what each section must discuss
- `TASK_THEME_IDS` — which themes apply per upload card
- `_coverage_level()` / Ready logic — how strict scoring is

After changes, re-run analysis on uploads (Refresh Analysis in UI or `build_document_training_data.py --reanalyze`).

---

## 5. How to redo the AI workflow to improve it (recommended cycle)

Use this **iteration loop** in your capstone methodology chapter:

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│ Collect     │ ──► │ Label in     │ ──► │ Train in    │ ──► │ Evaluate in  │
│ real uploads│     │ JSON / CSV   │     │ Jupyter     │     │ Jupyter      │
└─────────────┘     └──────────────┘     └─────────────┘     └──────────────┘
       ▲                                                              │
       │                                                              ▼
       │                    ┌──────────────┐     ┌─────────────┐
       └────────────────────│ Tune themes  │ ◄── │ Deploy +    │
                            │ / features   │     │ user test   │
                            └──────────────┘     └─────────────┘
```

### Iteration checklist

| Step | Action | Where |
|------|--------|-------|
| 1 | Export misclassified files from admin testing | `data/ipophl_documents.json` |
| 2 | Add corrected labels to `gi_documents_raw.json` | `training_data/` |
| 3 | Rebuild dataset | `python scripts/build_document_training_data.py` |
| 4 | Train + plot metrics in Jupyter | `01_beanthentic_ml_training.ipynb` |
| 5 | If CV accuracy &lt; 85%, tune hyperparameters or add samples | Notebook Section B |
| 6 | Update MoP themes if Ready/Not Ready disagrees with experts | `gi_reference_basis.py` |
| 7 | Save models | `train_ai_model.py` / `--train` script |
| 8 | Re-analyze stored uploads | `--reanalyze` flag |
| 9 | Restart `web.py` and regression-test 7 zones | Dashboard IPOPHL module |
| 10 | Record metrics in capstone | Tables + figures from notebook |

### What to improve first (priority order)

1. **More real labeled documents** — biggest gain for defensible accuracy.
2. **MoP theme mapping** — fixes what users actually see (Ready on cards).
3. **OCR quality** — scanned PDFs need good text extraction (`PyMuPDF` / `pytesseract`).
4. **RF hyperparameters** — GridSearch in notebook; diminishing returns after good data.
5. **Expert validation table** — human reviewer vs system (gold standard for thesis).

---

## 6. Metrics to report in your capstone paper

### Document ensemble

- Hold-out **accuracy**
- **CV mean ± std**
- **Confusion matrix** (TN, FP, FN, TP)
- **Precision / recall / F1** per class
- Report **sample size** and **class distribution**
- State clearly: trained on curated MoP text; validate on **held-out real uploads**

### MoP qualitative engine (IPOPHL production)

- **Theme coverage** (well_covered / partial / missing)
- **Expert agreement rate** on N documents
- Example **narrative explanation** from AI modal (explainability)

### Honest limitations (panel expects this)

- Ensemble accuracy on small samples ≠ legal IPOPHL approval
- Small or imbalanced real-world sets need ongoing labeling
- ML is **decision support**; MoP status is authoritative; administrators retain final review

---

## 7. File reference

| Path | Description |
|------|-------------|
| `machinelearning/notebooks/01_beanthentic_ml_training.ipynb` | Main Jupyter training notebook |
| `machinelearning/train_ai_model.py` | Production training CLI |
| `scripts/build_document_training_data.py` | Build document dataset + optional train |
| `scripts/verify_document_ml.py` | Quick smoke test after deploy |
| `machinelearning/document_training_results.json` | Document model metrics |
| `machinelearning/gi_document_model.joblib` | Trained document ensemble |
| `machinelearning/gi_reference_basis.py` | MoP qualitative engine |
| `machinelearning/gi_reference_basis.py` | MoP qualitative IPOPHL engine |
| `docs/THESIS_DEFENSE_SCRIPT_ADMIN.md` | Extended ML narrative for defense |

---

## 8. Quick command cheat sheet

```powershell
# Jupyter (use python -m on Windows if `jupyter` is not recognized)
python -m jupyter notebook machinelearning\notebooks\01_beanthentic_ml_training.ipynb

# Rebuild document training set
python scripts\build_document_training_data.py --target 200

# Train document RF + save joblib
python scripts\build_document_training_data.py --train

# Train farmer RF
python machinelearning\train_ai_model.py --full-pipeline

# Re-score all stored IPOPHL uploads after theme changes
python scripts\build_document_training_data.py --reanalyze

# Smoke test
python scripts\verify_document_ml.py
```

---

*Beanthentic — Capstone / IPOPHL GI documentation training guide.*
