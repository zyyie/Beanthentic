# GI Seal Demo Path (Admin)

Short walkthrough for thesis defense and admin training. Follow this exact order.

## Goal

Show how Beanthentic helps Lipa City prepare a **Kapeng Barako GI seal package**: gather required phase documents → AI review each upload → mark groups Ready → Complete Registration.

The Manual of Specifications (MoP) is **one document group among several**, not the sole basis of the system.

## Prerequisites

1. Admin is signed in on the dashboard.
2. Flask app (`web.py`) is running with a loaded document model.
3. Hard-refresh the browser (`Ctrl+Shift+R`) after any AI retrain.

## Demo script (about 5–7 minutes)

### 1) Open IPOPHL module

- Sidebar → **IPOPHL**
- Point out Phase 1–3 upload groups (Introduction, Justification, Technical, Control, MoP, etc.)

### 2) Upload a Kapeng Barako document

- Choose a Phase 1 group (e.g. Introduction / Justification)
- Upload a real Kapeng Barako GI draft (PDF/DOCX)
- Wait for upload + preview

**Talking point:** The AI reads the *file text*, not the filename alone.

### 3) Open Document Feedback

- Click the uploaded file to open preview + **Document Feedback**
- Show status badge: **Ready** or **Not Ready**
- Walk through:
  - Revision feedback (one clear verdict)
  - Theme coverage (what this upload group needs)
  - Action items (next edits)
  - IP pillar signals (Trademark / Copyright / Industrial Design / Patent)

**Talking point:** Review is against **GI seal filing requirements** for Kapeng Barako — MoP is just one of the documents admins collect.

### 4) Fix and Refresh Analysis

- If Not Ready: explain the priority gap (usually product identity or a thin theme)
- After editing the draft, re-upload or click **Refresh Analysis**
- Show status moving toward Ready when Kapeng Barako identity + required themes are present

### 5) Package readiness

- Return to IPOPHL progress / Analytics
- Show how many document groups are **Ready**
- Explain Complete Registration stays blocked until required phase groups are Ready

### 6) Complete Registration (when ready)

- Click **Complete Registration** only when required groups are Ready
- Show the package moving to GI Updates / contributions flow

## What to say if a wrong file is uploaded

If someone uploads literature or another product (e.g. mango GI):

- Status stays **Not Ready**
- Feedback asks for Kapeng Barako / Liberica / Batangas identity
- Retraining alone does not make a non-GI file Ready

## Optional: retrain mention

```bash
python scripts/build_document_training_data.py --train --reanalyze --target 200
```

Use this when new labeled GI samples are available. Ensemble confidence is advisory; document review decides Ready / Not Ready.

## One-sentence thesis closer

> Beanthentic pre-screens each Kapeng Barako GI upload against IPOPHL filing requirements so the LGU can assemble a complete, consistent seal package before formal submission.
