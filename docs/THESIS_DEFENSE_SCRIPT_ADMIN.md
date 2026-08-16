# Beanthentic Admin Site — Thesis Defense Script

**Presenter role:** Admin Web Application (Flask dashboard, port 5000)  
**Estimated delivery:** 18–25 minutes (adjust per panel time limit)  
**Ecosystem:** Beanthentic Admin + Beanthentic Mobile App + Beanthentic Client Web + Supabase PostgreSQL

---

## How to use this script

- Text in **bold** is suggested spoken wording.
- `[SLIDE n]` = change slide or screen section.
- `[DEMO]` = live or recorded demo moment.
- `Panel note` = extra detail if a judge asks a follow-up.

---

## PART 1 — OPENING (1–2 minutes)

`[SLIDE 1 — Title, team, institution]`

**Good [morning/afternoon], honorable panelists, advisers, and classmates.**

**I am [Your Name], and I will present the Beanthentic Administrator Web Application — the central management system for our coffee farmer platform here in Lipa City.**

**Beanthentic is not a single app. It is an ecosystem of three applications sharing one database:**

1. **Beanthentic Mobile App** — used by farmers to register farms, receive GI updates, and message administrators.  
2. **Beanthentic Client Web** — used by buyers and the public to view products and report misconduct.  
3. **Beanthentic Admin** — *my assigned component* — used by LGU staff, IPOPHL coordinators, and system administrators to manage farmers, review documents, run analytics, and moderate the platform.

**The admin site is built with Python Flask on the backend and a single-page dashboard on the frontend. All farmer records, messages, transactions, and GI documents flow into this dashboard so administrators never need to open multiple tools.**

`Panel note:` Admin runs on port 5000; mobile API on 8080; client web on 5001; production target is cloud hosting (e.g., Render + Supabase).

---

## PART 2 — PROBLEM & OBJECTIVES (2 minutes)

`[SLIDE 2 — Problem statement]`

**Lipa City coffee farmers face two parallel challenges:**

1. **Operational** — farm data is scattered across paper forms, spreadsheets, and personal phones.  
2. **Regulatory** — registering *Lipa Barako* under IPOPHL Geographical Indication requires dozens of legal and technical documents across five phases.

**Without a unified admin system, staff cannot:**

- See which farmers are registered and GI-ready.  
- Track IPOPHL document completeness.  
- Push official GI updates to farmers’ phones.  
- Review client misconduct reports or farmer messages in one place.

**Our admin site solves this by providing one secure dashboard for records, compliance, communication, analytics, and AI-assisted document review.**

**Specific objectives my module addresses:**

| Objective | Admin feature |
|-----------|----------------|
| Centralize farmer records | Farmer's Record + Farmer's Profile |
| Support IPOPHL GI workflow | IPOPHL module (5 phases, 13 document groups) |
| Automate document screening | Machine Learning document analyzer (MoP + ensemble) |
| Monitor GI document progress | Analytics (MoP Ready / phase completion) |
| Enable farmer–admin communication | Messaging module |
| Monitor platform health | Analytics + Notifications |

---

## PART 3 — SYSTEM ARCHITECTURE (2–3 minutes)

`[SLIDE 3 — Architecture diagram]`

**Let me explain how the admin site connects to everything else.**

```
[Farmer Phone] ──► Beanthentic-App (:8080)
[Buyer Browser] ──► Client Web (:5001)
[Admin Browser] ──► Admin Dashboard (:5000)  ◄── YOU ARE HERE
                         │
                         ▼
              Supabase PostgreSQL (shared database)
              Supabase Storage (profile photos, files)
```

**When an administrator logs in, the browser loads one HTML page — our dashboard shell — and JavaScript switches between modules without reloading the entire site. That keeps the experience fast, similar to Gmail or Facebook Admin.**

**On the server side, Flask exposes REST APIs under `/api/...`. Each API module handles one domain: farmers, messages, GI contributions, IPOPHL, machine learning, and so on.**

**Data loading uses a resilient pattern:**

1. **Primary:** Direct connection to **Supabase PostgreSQL** (cloud).  
2. **Fallback (LAN demos):** HTTP bridge to the mobile app server or local MySQL if cloud is unavailable.

**This means the admin still works during field testing on campus Wi‑Fi even if one server is temporarily down.**

`Panel note:` `config/app_data_load.py` implements `load_with_app_bridge()` — Supabase first, then MySQL, then HTTP.

---

## PART 4 — AUTHENTICATION & SECURITY (1–2 minutes)

`[SLIDE 4 — Security]`

**Before any module loads, the administrator must authenticate.**

**Features:**

- **Login / Signup** — phone-based admin accounts stored securely with password hashing (Werkzeug).  
- **Forgot password** — SMS OTP sent through our SMS gateway; OTP verified before password reset.  
- **Session management** — Flask sessions; unauthorized API calls return HTTP 401.  
- **Farmer moderation** — warn, suspend (default 3 days), or unsuspend accounts from the farmer list or profile.  
- **Activity log** — records admin actions with timestamp and IP address.  
- **Account deactivation** — admin can deactivate their own account with password confirmation.

**Farmer-facing moderation is important for platform trust: if a farmer violates community rules, the admin can suspend the account without deleting historical farm data.**

`[DEMO — optional]` Show login → dashboard → Settings → Activity Log.

---

## PART 5 — MODULE WALKTHROUGH (10–12 minutes)

`[SLIDE 5 — Dashboard overview screenshot]`

**I will now walk through every major function of the admin dashboard, module by module.**

---

### 5.1 Dashboard Overview

**The Overview module is the landing page after login.**

**It displays four KPI cards computed from live farmer data:**

- Total registered farmers  
- Total coffee trees (bearing + non-bearing)  
- Total hectares planted  
- Total production in kilograms  

**It also includes:**

- A **calendar widget** for scheduling.  
- A **farmer registration chart** showing registration volume over time (Chart.js).  
- Quick navigation to other modules.

**Data source:** `GET /api/farmer-data` — pulls from the shared `farmers` table joined with personal information, farm information, tree counts, and production tables.

**Why it matters:** Administrators see system health at a glance without opening spreadsheets.

---

### 5.2 Farmer's Record

`[DEMO — Farmer's Record table]`

**This is the operational heart of the system — a spreadsheet-style view of every registered farmer.**

**User-facing features:**

| Feature | Explanation |
|---------|-------------|
| **Search** | Filter by name, barangay, FA officer, NCFRS ID |
| **Five table tabs** | Basic Info, Affiliation, Farm Info, Tree Counts, Production — each tab shows different columns from the database |
| **Pagination** | 10, 25, or 50 rows per page |
| **Export** | Download Excel-compatible CSV, PDF summary, or CSV |
| **Account actions** | Warning, Suspend, Unsuspend per farmer |

**Backend:**

- `GET /api/farmer-data` — main data endpoint; supports PostgreSQL direct query or app-server bridge.  
- `POST /api/farmer-account-action` — writes warning/suspension to `farmers` table (`is_suspended`, `suspended_until`, `warning_count`).  
- `config/farmer_moderation.py` — business rules for suspension duration and validation.

**Registration completeness filter:** Only farmers who finished the mobile “Register Farm” wizard (valid first name, last name, not phone-number placeholders) appear in the list. This prevents junk or half-finished registrations from cluttering the admin view.

`Panel note:` `config/farmer_registration_complete.py` enforces completion rules.

---

### 5.3 Farmer's Profile

`[DEMO — Card grid + profile detail]`

**While Farmer's Record is table-oriented, Farmer's Profile is visual.**

**Features:**

- **Card grid** with farmer name, status badge (Active / Suspended with countdown), and profile photo.  
- **Profile photo** loaded from database via `/api/farmer-profile-photo/{id}` — supports Supabase Storage URLs, inline data, or cloud retrieval.  
- **Collapsible sections** — personal info, affiliation, farm info, tree counts, production.  
- **Message farmer** button — jumps to Messaging module with that farmer pre-selected.  
- **Per-farmer transaction history** — approved sales linked to that farmer.

**Why two farmer views?** Records staff need bulk editing and export; field officers need a quick visual scan of who is active, suspended, and identifiable by photo.

---

### 5.4 Maps

**The Maps module plots farmers geographically across Lipa City barangays.**

**Features:**

- Stadia Maps via Leaflet (free tier on localhost; API key or domain auth for production).  
- Pins colored or filtered by variety: Liberica, Robusta, Excelsa, or All.  
- Barangay search.  
- Side panel with geographic statistics.

**Data:** Same farmer dataset; barangay and variety fields drive pin placement.

**Purpose:** Supports LGU planning — which barangays have the most coffee activity, and where GI outreach should focus.

---

### 5.5 Client Transaction

**This module shows coffee purchase transactions from the Client Web application.**

**Features:**

- Table of approved/sent transactions (buyer name, product, quantity, payment method, reference number).  
- Receipt modal with full transaction details.  
- Search and filter.

**Backend:** `GET /api/transactions-list` reads `customer_transactions` from the shared database — the same records farmers and clients see on mobile.

**Admin value:** Fraud detection and reconciliation — staff can verify that client-side purchases match farmer records.

---

### 5.6 Client Report (Misconduct)

**When a buyer reports inappropriate behavior on the Client Web, the report appears here.**

**Features:**

- List of misconduct reports with status: Pending, Under Review, Blocked, Resolved, Dismissed.  
- Search and refresh.  
- Status update via PATCH API.

**Backend:**

- `GET /api/client-reports-list`  
- `PATCH /api/misconduct-reports/{id}`

**Table:** `client_misconduct_report` on Supabase.

**Purpose:** Closes the loop between public-facing client app and internal moderation.

---

### 5.7 IPOPHL Module (Geographical Indication Registration)

`[SLIDE 6 — IPOPHL 5 phases diagram]`  
`[DEMO — Upload document + AI score]`

**This is the most complex and legally significant module. It digitizes the IPOPHL GI registration workflow for Lipa Barako coffee.**

**Structure — 5 phases, 13 document groups:**

| Phase | Name | Example documents |
|-------|------|-------------------|
| 1 | Pre-Application | Product specification, area map, producer organization papers |
| 2 | Document Preparation | Manual of Specifications, labeling rules, quality control |
| 3 | Filing | Application form, official receipt, power of attorney |
| 4 | Examination | Responses to deficiency notices, formality examination |
| 5 | Registration | GI certificate, compliance monitoring |

**Administrator workflow:**

1. **Upload** PDF, Word, or image for a specific task slot.  
2. **AI analyzes** the document automatically (explained in Part 6).  
3. **Review** AI score, detected keywords, missing requirements, and SHAP explanation.  
4. **Publish** approved documents to all farmers’ GI Updates inbox on mobile.  
5. **Complete Registration** — batch publish Phase 5 and generate ZIP for email submission to IPOPHL.

**Key API endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `POST /api/ipo-analyze` | Upload + run AI analysis |
| `GET /api/ipo-documents` | List all uploaded documents |
| `GET /api/ipo-preview/{uuid}` | Preview document metadata |
| `POST /api/ipophl/publish-task` | Push one document to farmer GI Updates |
| `POST /api/ipophl/complete-registration` | Batch complete + publish |
| `GET /api/ipophl/registration-zip` | Download all files as ZIP |
| `GET /api/ipophl/gmail-compose` | Open Gmail with pre-filled IPOPHL submission |

**Frontend:** `js/ipophl-analyzer.js` handles upload UI, progress, and AI results modal.

**Storage:** Document metadata in `data/ipophl_documents.json` plus optional `DocumentAnalysis` database table; files in `machinelearning/uploads/`.

---

### 5.8 Farmer's Contribution (GI Inbox)

`[DEMO — Contribution list with read/unread styling]`

**While IPOPHL is admin → outward (official documents to farmers), Farmer's Contribution is farmer → inward.**

**Features:**

- **Gmail-style inbox** for farmer GI submissions (`gi_farmers_contribution` table).  
- Tabs: Inbox, Starred, Approved, Archived, Documents, Images.  
- Bulk select, archive, mark reviewed, delete.  
- **Read/unread styling** — unread items show bold text and a red dot; read items are greyed out (same UX as Messaging).  
- **Detail modal** with attachments (PDFs, images) served from `/uploads/gi_contributions/`.

**Admin broadcast (outbound):**

- `POST /api/gi-contributions-send` — send GI update with attachments to one farmer or all farmers.  
- Files mirrored to admin storage so mobile app can download on any network.

**Backend:** `api/gi_contributions_api.py` — list, patch, delete, send, serve files.

---

### 5.9 Messaging

`[DEMO — Chat list + thread]`

**A Messenger-style interface for administrator ↔ farmer communication.**

**Features:**

- Conversation list sorted by latest message.  
- Full thread view with sent/received bubbles.  
- Compose new message to any farmer (farmer picker).  
- Star, archive, delete messages.  
- Mark thread read → updates database and greys out list item.  
- **Header badge** — red notification count for unread farmer messages.

**Backend:**

- Shared table: `shared_messages` on Supabase.  
- APIs: `/api/messages`, `/api/messages/thread`, `/api/messages/mark-thread-read`, `/api/messages/unread-count`.  
- Mobile app writes farmer messages; admin reads and replies from this module.

**Design choice:** Phone number is the thread key — farmers are identified by mobile number, matching how they register on the app.

---

### 5.10 Analytics

`[SLIDE 7 — Analytics charts]`

**The Analytics module turns raw data into decision-support visuals.**

**KPI cards:**

1. **Documents Passed AI Review** — count of IPOPHL uploads scoring ≥ 70% on AI analysis.  
2. **IPOPHL Progress** — percentage of 13 document groups that have at least one file uploaded.

**Charts (Chart.js):**

| Chart | What it shows |
|-------|----------------|
| IPOPHL Phase Completion | Completed vs pending groups per phase |
| Document Upload Timeline | Upload activity by month |
| Top 5 Barangays | Farmer concentration by barangay |
| GI-Ready Farmer Growth Trend | Cumulative GI-ready farmers over time |
| GI Readiness Gauge | % of farmers classified as GI-ready |

**GI readiness source:** Rule-based eligibility (500+ trees, RSBSA registered, NCFRS ID present). AI analysis is focused on GI documents (MoP + document ensemble), not farmer-profile ML.

---

### 5.11 Notifications (Header Bell)

**Aggregates events from across the system:**

- New farmer messages  
- New transactions  
- New registrations  
- Misconduct reports  
- IPOPHL upload events  

**Clicking a notification navigates directly to the relevant module (e.g., Messaging, Client Report).**

**API:** `GET /api/admin-notifications` — built by `config/admin_notifications.py`.

---

### 5.12 Settings & Account

| Sub-section | Function |
|-------------|----------|
| **Account Security** | Change password, 2FA placeholder |
| **Activity Log** | Audit trail of admin actions |
| **FAQ** | Static help for staff |
| **Profile Actions** | Notification preferences |
| **Header Account** | Profile photo (camera upload), personal info, app version check, account deactivation |

---

### 5.13 Social Media

**Shortcut button to open the official Beanthentic Facebook page — supports public outreach without leaving the workflow context.**

---

### 5.14 Export

**From Farmer's Record, administrators export:**

- `/export/excel` — CSV compatible with Excel  
- `/export/pdf` — text summary report  
- `/export/csv` — comma-separated values  

**Use case:** LGU reporting, backup, and integration with legacy government spreadsheets.

---

## PART 6 — MACHINE LEARNING (DEEP DIVE, EASY LANGUAGE) (8–10 minutes)

`[SLIDE 8 — ML pipeline diagram]`

**Panelists, this section explains our artificial intelligence component. I will use plain language first, then technical terms.**

---

### 6.1 What problem does ML solve?

**IPOPHL registration involves many documents. Each document must contain specific legal and technical terms — for example “Manual of Specifications,” “Geographical Indication,” “Official Receipt.”**

**Manually checking every page is slow and error-prone.**

**We built a GI document AI assistant:**

1. **MoP qualitative review** — authoritative Ready / Not Ready from official Manual of Specifications themes.  
2. **Document ensemble (advisory)** — soft-voting bagging + boosting score that agrees or disagrees with MoP.

---

### 6.2 Simple analogy for the panel

**Imagine a experienced IPOPHL staff member who has read hundreds of successful applications. They develop a checklist in their head:**

- “This document mentions Manual of Specifications — good.”  
- “I don’t see Official Receipt — incomplete.”  

**Our system automates that checklist in two ways:**

- **Rules / MoP themes** — explicit coverage per IPOPHL phase (transparent, easy to audit).  
- **Machine Learning** — a document ensemble trained on labeled MoP samples (advisory layer).

**We combine both for documents — hybrid scoring — so the system is neither a black box nor purely manual.**

---

### 6.3 Document AI — step by step

**Step 1: Text extraction**

| File type | Tool |
|-----------|------|
| PDF (text-based) | PyMuPDF — reads embedded text |
| PDF (scanned/image) | Tesseract OCR — reads text from images |
| Word (.docx) | python-docx — reads paragraphs and tables |
| Plain text | Direct UTF-8 read |

*If a farmer scans a paper form, OCR converts the image to text before analysis.*

**Step 2: Task-aware keyword matching (rule-based)**

- We defined **13 task groups** matching IPOPHL’s registration checklist.  
- Each task has **mandatory terms** (must appear) and **optional terms** (strengthen the application).  
- Example mandatory terms: “Geographical Indication,” “Lipa City,” “Barako,” “Official Receipt.”  
- **Synonyms** are mapped — e.g., “authorization letter” counts toward legal standing terms.

**Scoring formula (rules — task-aware):**

For each of the **13 IPOPHL upload zones**, the system uses a **task-specific checklist** (not one generic list for all documents):

| Coverage | Points | Plain meaning |
|----------|--------|---------------|
| All **mandatory** keywords found | **85% base** | Document meets minimum IPOPHL requirements for that task |
| **Optional** keywords on top | **+0 to 15%** | Stronger, more complete submission |
| Missing mandatory keywords | **0–84%** | Scales with how many mandatory terms are still absent |

- **Total 0–100.** Score **≥ 75 = Ready**, below 75 = needs revision.  
- **Example:** A Phase 1 Product document with all four mandatory terms (Lipa Barako coffee, Flavor Profile, Geographical Origin, Distinctive Quality) plus three optional terms scores **96%** — not capped at 70% just because optional terms are incomplete.

**Synonym matching:** Real IPOPHL filings do not use identical wording every time. The engine maps synonyms — e.g., “Kapeng Barako” and “Coffea liberica” count toward “Lipa Barako coffee”; “roast” counts toward “Roasting Process.” This mirrors how a human reviewer would interpret substance, not just exact phrase matching.

**Step 3: Machine Learning document classifier (statistical enhancement)**

- Algorithm: **Random Forest Classifier** (scikit-learn).  
- **Input features per document (46 total):**
  1. `text_length` — character count (longer filings often more complete).  
  2. `word_count` — vocabulary size.  
  3. **44 binary keyword flags** — one per term in the global GI checklist (20 mandatory + 24 optional), e.g., “Manual of Specifications,” “Geographical Indication,” “Lipa City,” “Barako,” “Official Receipt,” each scored 1 = present, 0 = absent.  
- **Output:** `predict_proba` → probability that document class = **“Ready”** (converted to 0–100%).  
- **Training labels:** Each training row is labeled **Ready** or **Not Ready** by humans or by rule-based auto-labeling against the task checklist.  
- **Training file:** `machinelearning/training_data/gi_documents_raw.json` (see **Section 6.3A** for full dataset design).

**Important design choice:** At **analysis time**, keyword matching uses the **task-specific** checklist (13 IPOPHL zones). At **training time**, the Random Forest uses the **global** GI feature vector so one model can generalize across document types. Rules handle per-task precision; ML handles overall “does this look like a GI filing?” patterns.

**Step 4: Hybrid merge (rules + ML)**

When the document model (`gi_document_model.joblib`) is loaded, the system uses **hybrid scoring** — but not a blind average:

| Situation | Final score logic | Why |
|-----------|-------------------|-----|
| **All mandatory task keywords found** | Final score = **Rule score** | Checklist compliance is legally auditable; ML does not penalize a complete filing |
| **Mandatory keywords still missing** | `25% × ML + 75% × Rules` | ML helps on borderline or incomplete drafts where pattern detection adds value |

**Why hybrid?** Rules align directly with IPOPHL checklists (explainable to lawyers and LGU staff). ML adds statistical pattern detection trained on labeled examples. Together they are more robust than either alone — and the merge logic prevents a weak or small training set from dragging down clearly compliant documents.

**Step 5: Explainability (SHAP)**

- We use **SHAP (SHapley Additive exPlanations)** on the Random Forest.  
- SHAP answers: *“Which words increased or decreased the readiness score?”*  
- The admin sees an HTML narrative — e.g., “Presence of ‘Manual of Specifications’ increased score by 12 points; missing ‘Official Receipt’ decreased score by 8 points.”

**This is critical for thesis ethics:** administrators understand *why* the AI gave a score, not just the number.

---

### 6.3A Document Training Data — How We Built the Labeled Dataset (DETAILED)

`[SLIDE 8b — Document training data pipeline]`

**Panelists, this subsection answers: “Where did the document AI learn from, and how did you label the data?”**

#### Why training data matters

A Random Forest does not “understand” IPOPHL law. It learns from **examples**:

- “Documents that look *like this* were labeled **Ready**.”  
- “Documents that look *like this* were labeled **Not Ready**.”

If we train on only **7 sample paragraphs**, the model memorizes noise instead of learning GI patterns — our early prototype showed **~42% cross-validation accuracy** and **0% hold-out accuracy** on that tiny set. That is why we built a structured dataset pipeline before claiming document ML in the defense.

#### Dataset location and format

**File:** `machinelearning/training_data/gi_documents_raw.json`

Each record is one JSON object:

```json
{
  "text": "Full extracted document text (not a file path)...",
  "label": "Ready",
  "score": 96,
  "source": "generated",
  "task_id": "phase1-product",
  "notes": "Auto-generated Ready sample for phase1-product"
}
```

| Field | Purpose |
|-------|---------|
| `text` | Plain text extracted the same way as live uploads (PyMuPDF / OCR / python-docx) |
| `label` | **Ready** or **Not Ready** — this is what the classifier learns |
| `score` | Reference readiness 0–100 from rules (metadata only, not the ML label) |
| `source` | Where the row came from (`sample`, `generated`, `upload`, `hard_negative`, etc.) |
| `task_id` | Which of the 13 IPOPHL zones the document belongs to (when known) |
| `notes` | Human-readable description for thesis documentation |

#### Four sources of training data (our pipeline)

We automated dataset construction with `scripts/build_document_training_data.py`:

**Source 1 — Legacy seed samples (7 documents)**  
Original demonstration texts shipped with the project: complete GI product specs, Manual of Specifications, producer organization docs, plus intentional negatives (generic coffee report, HR authorization letter). These anchor the model to realistic Lipa Barako vocabulary.

**Source 2 — Programmatic generation per IPOPHL task (39+ documents)**  
For **each of the 13 upload zones**, the script generates three variants:

| Variant | Label | Content strategy |
|---------|-------|------------------|
| **Complete filing** | Ready | Embeds every **mandatory** and **optional** keyword for that task plus global GI context (Lipa City, Batangas, Barako, Geographical Indication) |
| **Incomplete draft** | Not Ready | Generic coffee farm text with **no** task mandatory terms |
| **Partial draft** | Not Ready | Mentions only the **first** mandatory term — simulates work-in-progress uploads |

Additionally, a **second Ready paraphrase** per task teaches the model that different wording still means “Ready” — e.g., “Section: Manual of Specifications — satisfies IPOPHL formality examination” vs. a narrative paragraph with the same legal meaning.

**Source 3 — Hard negatives (3 documents)**  
Documents that must **never** score as GI-ready:

- Unrelated authorization letter (HR / retirement)  
- Commercial invoice  
- Synthetic 100% keyword test file (used to validate the **rule engine**, labeled Ready when all product terms appear)

Hard negatives teach the model to reject **wrong document types** even when some coffee words appear.

**Source 4 — Local upload ingestion (auto-labeled)**  
Any PDF, DOCX, or TXT in `machinelearning/uploads/` is:

1. Text-extracted with the same `GIAnalyzer` used in production.  
2. Scored with the **task-aware rule engine** (using `task_id` from content if the file declares `Upload zone: phase1-product`).  
3. Auto-labeled **Ready** if all mandatory terms are present and score ≥ 75%; otherwise **Not Ready**.

This lets administrators **grow the dataset organically** every time they upload real IPOPHL drafts during development.

#### Final dataset statistics (June 2026 training run)

| Metric | Value |
|--------|-------|
| **Total documents** | **84** |
| **Ready** | **30** |
| **Not Ready** | **54** |
| **Tasks covered** | All **13** IPOPHL upload zones |
| **Deduping** | Normalized text prefix deduplication prevents duplicate rows |

**Class imbalance note for panel:** We have more Not Ready than Ready samples on purpose — incomplete drafts and wrong document types are common in real workflows. Training uses `class_weight="balanced"` so the Random Forest does not ignore the minority Ready class.

#### How labels relate to IPOPHL compliance

| Label | Thesis definition (operational) |
|-------|------------------------------|
| **Ready** | Document text contains **all mandatory keywords** for its IPOPHL task (or global GI completeness for unassigned uploads), consistent with a submittable draft |
| **Not Ready** | Missing mandatory terms, wrong document category, or insufficient GI vocabulary |

**We do not claim** that ML “Ready” equals IPOPHL legal approval — it means **AI-assisted pre-screening passed**, after which a human administrator still reviews before publishing to farmers.

#### Text extraction parity (train = test)

Training rows must use the **same extraction path** as live analysis:

| Format | Tool |
|--------|------|
| PDF (digital text) | PyMuPDF (`fitz`) |
| PDF (scanned) | Tesseract OCR via Pillow |
| DOCX | python-docx |
| TXT | UTF-8 read |

If training text is copied manually but production uses OCR on scans, the model will underperform — we ingest uploads precisely to avoid that train/serve skew.

#### Task mismatch handling (data quality lesson)

During testing we found a document named `phase1-product_100pct.pdf` uploaded to the **Entity** slot while its body declared `Upload zone: phase1-product`. Rule scoring against Entity mandatory terms produced **8%** even though the content was a perfect Product document.

**Fix in production:** `_resolve_task_id_from_text()` reads the declared upload zone from document body before scoring. **Lesson for training:** labels must match the **intended IPOPHL task**, not just the upload UI slot the user clicked.

---

### 6.3B Document Training Procedure & Results (DETAILED)

`[SLIDE 8c — Training command + metrics table]`

#### Training script and commands

**Primary pipeline (recommended):**

```bash
# From project root — rebuild dataset, train model, re-score stored uploads
python scripts/build_document_training_data.py --train --reanalyze
```

**Low-level training only:**

```bash
cd machinelearning
python train_ai_model.py --train-documents
```

**Full pipeline (farmer CSV + document JSON):**

```bash
cd machinelearning
python train_ai_model.py --full-pipeline
```

**Admin UI (production):** `POST /api/ml/train` (admin-only) invokes the same training pipeline on the server.

#### Step-by-step training procedure

**Step 1 — Load dataset**  
`train_ai_model.py` reads `gi_documents_raw.json`. If missing, it falls back to 7 built-in samples (development only).

**Step 2 — Feature extraction**  
For each `text` field, `GIAnalyzer._extract_features()` builds the 46-dimensional vector (length, word count, 44 keyword flags). **Identical** to runtime inference — no separate feature engineering code path.

**Step 3 — Label encoding**  
`Ready` → 1, `Not Ready` → 0.

**Step 4 — Train / test split**  
80% training, 20% hold-out test. Stratified split when sample count allows (preserves Ready / Not Ready ratio in both sets).

**Step 5 — Hyperparameter search (GridSearchCV)**  
Random Forest hyperparameters searched:

| Parameter | Values tried | Effect |
|-----------|--------------|--------|
| `n_estimators` | 50, 100, 200 | Number of trees in the forest |
| `max_depth` | 10, 20, unlimited | Tree depth — controls overfitting |
| `min_samples_split` | 2, 5, 10 | Minimum samples to split a node |
| `min_samples_leaf` | 1, 2, 4 | Minimum samples per leaf |
| `max_features` | sqrt, log2 | Features considered per split |

**Cross-validation folds:** 5-fold when ≥ 25 samples; 3-fold when ≥ 15; 2-fold for smaller sets.

**Class balancing:** `class_weight="balanced"` adjusts for unequal Ready vs Not Ready counts.

**Step 6 — Model persistence**  
Best estimator saved to:

- `machinelearning/gi_document_model.joblib`

Metrics saved to:

- `machinelearning/document_training_results.json`

**Step 7 — Hot reload**  
Restart `web.py` so `GIAnalyzer` loads the new `.joblib` file on startup.

#### Reported document ML results (June 2026 — 84-sample run)

| Metric | Value | Plain interpretation |
|--------|-------|----------------------|
| Hold-out test accuracy | **100%** | All documents in the 20% test split classified correctly |
| Cross-validation mean | **91.5%** (± 9.3%) | Model generalizes across folds — more honest than a single split |
| Training samples | **84** | Up from 7 in the prototype |
| Ready / Not Ready | **30 / 54** | Imbalanced but handled with balanced class weights |
| Best `n_estimators` | **50** | Smaller forest sufficient for keyword-feature data |
| Best `max_depth` | **10** | Prevents over-memorizing generated text |

**Confusion matrix (hold-out):**

|  | Predicted Not Ready | Predicted Ready |
|--|-------------------|-----------------|
| **Actual Not Ready** | 11 | 0 |
| **Actual Ready** | 0 | 6 |

**Precision / recall:** Both classes achieved **1.0** on the hold-out set for this run.

**Honest caveat for panel:** 100% hold-out accuracy on generated + curated data does **not** guarantee 100% on unseen real IPOPHL PDFs with OCR noise, handwriting, or novel layouts. Cross-validation ~91.5% already hints at some variance. **Future work:** label 50–100 **real** approved/rejected IPOPHL filings from LGU partners.

#### What the model learns (feature importance intuition)

Because features are mostly **keyword presence flags**, the Random Forest effectively learns combinations such as:

- Long text + “Manual of Specifications” + “Geographical Indication” + “Lipa City” → likely Ready.  
- Short text + no GI terms + authorization-letter vocabulary → likely Not Ready.

SHAP on top of this forest explains **which flags moved** a specific uploaded file’s score — shown to the administrator in the IPOPHL preview modal.

#### Retraining workflow (for LGU / thesis continuation)

1. Collect new real IPOPHL PDFs → place in `machinelearning/uploads/` **or** append JSON rows manually.  
2. Set correct `label` and `task_id` for each (administrator review).  
3. Run `python scripts/build_document_training_data.py --train --reanalyze`.  
4. Review `document_training_results.json` — target **CV mean ≥ 85%** before trusting ML on borderline cases.  
5. Restart admin server; spot-check 3–5 uploads in the IPOPHL demo.

#### Spoken summary for panel (30 seconds)

> “We train the document classifier on labeled text extracted the same way as production uploads. Our dataset has 84 documents covering all 13 IPOPHL tasks, with Ready and Not Ready examples including hard negatives like authorization letters. We use Random Forest with balanced class weights and grid-searched hyperparameters, achieving 91.5% cross-validated accuracy. At runtime, task-specific keyword rules remain authoritative when all mandatory terms are present; machine learning adds value on incomplete drafts. The system is retrainable as Lipa City collects more real GI filings.”

---

### 6.4 Farmer profile eligibility (rules only — not ML)

**Farmer GI eligibility in Analytics uses transparent rules** (for example 500+ trees, RSBSA registered, NCFRS present). There is **no farmer tabular ML model** in the product; AI focuses on GI document analysis.

---

### 6.5 ML API summary

| Endpoint | Who can call | Purpose |
|----------|--------------|---------|
| `GET /api/ml/status` | Logged-in user | Check if document model is loaded |
| `POST /api/ml/train` | Admin only | Retrain document ensemble (`train_ai_model.py --train-documents`) |

**Document dataset builder:** `scripts/build_document_training_data.py` — rebuilds document samples, trains `gi_document_model.joblib`, optionally re-scores `data/ipophl_documents.json`.

**Core engine file:** `machinelearning/ai_engine.py` — class `GIAnalyzer`.

**Libraries used:** scikit-learn, pandas, numpy, joblib, SHAP, PyMuPDF, python-docx, pytesseract, Pillow.

**Not used:** TensorFlow, PyTorch, OpenCV deep learning — our problem is structured document text and MoP themes, not image classification. OCR handles scanned documents without a neural network.

---

### 6.6 How ML appears in the demo

`[DEMO — IPOPHL upload showing MoP status + ensemble chip]`

1. Upload a PDF to any IPOPHL task slot.  
2. Show MoP Ready / Not Ready (authoritative) and ensemble advisory chip.  
3. Open analysis modal — feedback narrative, missing themes.  
4. Switch to Analytics — show “Documents MoP Ready” KPI and IPOPHL phase completion.

---

## PART 7 — DATABASE & INTEGRATION (1–2 minutes)

`[SLIDE 9 — Database tables]`

**Shared Supabase PostgreSQL tables the admin reads/writes:**

| Table | Admin use |
|-------|-----------|
| `farmers`, `personal_information`, `farm_information`, `tree_counts`, `production_information` | Farmer records |
| `shared_messages` | Messaging |
| `customer_transactions` | Client transactions |
| `client_misconduct_report` | Client reports |
| `gi_farmers_contribution` | Farmer GI submissions |
| `gi_updates` | Admin broadcasts to mobile |
| `users` | Mobile user accounts |

**Supabase Storage:** `profile-photos` bucket for farmer registration selfies.

**Admin exposes `GET /api/supabase-config`** so mobile and client apps discover the database URL and anon key securely.

---

## PART 8 — TESTING & VALIDATION (1 minute)

**We validated the admin site through:**

- Functional testing of each module (farmer load, message send, GI upload, export).  
- ML evaluation metrics — document ensemble metrics in `document_training_results.json` (confusion matrix, classification report); MoP qualitative review for production Ready / Not Ready.  
- LAN integration testing with mobile app on same Wi‑Fi.  
- Error handling when app server or database is unreachable (graceful error messages, connection settings page).

`Panel note:` Be prepared to show `GET /api/connection-status` or `/api/app-db-status` diagnostics.

---

## PART 9 — LIMITATIONS & FUTURE WORK (1 minute)

**Limitations we acknowledge openly:**

1. Document ML trained on a **small curated MoP sample set** — needs **real approved/rejected IPOPHL PDFs** from LGU for production-grade validation; MoP qualitative review remains authoritative for Ready / Not Ready.  
2. OCR quality on **poor scans** can reduce analysis quality — administrators should re-upload clearer scans when results seem unexpectedly low.  
3. Farmer eligibility charts use **transparent rules** (trees / RSBSA / NCFRS), not ML — they are operational metrics only.

**Future work:**

- Collect **50–100 real training labels** from IPOPHL outcomes (approved vs deficiency notices).  
- Deploy admin + app to cloud (Render, Supabase) for production.  
- Push notifications for new messages and GI submissions.

---

## PART 10 — CLOSING (1 minute)

`[SLIDE 10 — Summary + Thank you]`

**In summary, the Beanthentic Admin Web Application is the command center of our ecosystem. It centralizes farmer records, digitizes the IPOPHL GI registration workflow, applies machine learning to GI document screening (MoP + ensemble), and connects administrators with farmers through messaging and GI updates.**

**It is built on Flask, JavaScript, Supabase, and scikit-learn — technologies chosen for maintainability, explainability, and suitability for government and academic use.**

**Thank you, panelists. I am ready for your questions.**

---

## APPENDIX A — ANTICIPATED PANEL QUESTIONS & ANSWERS

### Q: Why Flask instead of Django or Laravel?
**A:** Flask is lightweight and fits our modular API design — each feature is a separate `api/*.py` blueprint. Our team already uses Python for machine learning, so one language for ML + backend reduces complexity.

### Q: Is the ML accurate enough for real IPOPHL decisions?
**A:** The ML is a **decision support tool**, not a legal authority. Final submission still requires human review. Hybrid scoring plus SHAP explanations make recommendations auditable. Farmer model achieved **82%** on held-out test data. Document model achieved **91.5% cross-validated accuracy** on an **84-document** labeled set covering all 13 IPOPHL tasks; when all mandatory keywords for a task are detected, the **rule-based checklist** sets the final score so legally complete drafts are not penalized by ML uncertainty.

### Q: How was the document training data collected and labeled?
**A:** We built `gi_documents_raw.json` from four sources: (1) seed samples, (2) programmatic Ready/Not Ready/Partial examples for each of the 13 IPOPHL upload zones, (3) hard negatives like authorization letters, and (4) auto-labeled text from uploads in `machinelearning/uploads/`. Each row has `text`, `label` (Ready/Not Ready), and optional `task_id`. Labels mean “passes AI pre-screening for that IPOPHL task,” not final IPOPHL legal approval. Retraining is one command: `python scripts/build_document_training_data.py --train`.

### Q: Why did a document score low even when it looked complete?
**A:** Three common causes: (1) uploaded to the **wrong IPOPHL slot** — scoring uses that task’s mandatory keywords; (2) **OCR failure** on scanned PDFs — text not extracted; (3) early prototype **hybrid weighting** let a weak 7-sample ML model drag down rule scores — fixed by expanding training data to 84 samples and making rules authoritative when all mandatory terms are found.

### Q: Why Random Forest and not neural networks?
**A:** Our inputs are tabular farm features and keyword presence — not millions of images. Random Forest performs well on structured data, trains on modest hardware, and supports SHAP explainability required for institutional trust.

### Q: How do you handle security?
**A:** Password hashing, session auth, SMS OTP reset, farmer suspension, activity logging, Supabase RLS with anon key, admin-only routes for training and sensitive operations.

### Q: What happens if the internet is down?
**A:** For campus demos, LAN fallback can read from the local app server. Production design targets cloud Supabase for reliability. Connection Settings page helps diagnose failures.

### Q: How does admin sync with the mobile app?
**A:** Both read/write the same Supabase database. When admin publishes a GI document, it inserts into `gi_updates`; mobile app polls or loads GI Updates API. Farmer registration writes to `farmers`; admin reads via `/api/farmer-data`.

### Q: What is SHAP in one sentence?
**A:** SHAP measures how much each feature (or keyword) pushed the prediction toward “Ready” or “Not Ready,” similar to showing which exam answers raised or lowered your grade.

---

## APPENDIX B — DEMO CHECKLIST (rehearse in order)

- [ ] Login as admin  
- [ ] Overview KPIs populate  
- [ ] Farmer's Record — search, switch tabs, export  
- [ ] Farmer's Profile — photo, suspend badge, open profile  
- [ ] IPOPHL — upload document, show AI score + SHAP  
- [ ] Farmer's Contribution — unread vs read styling, open attachment  
- [ ] Messaging — unread badge, open thread, mark read  
- [ ] Analytics — IPOPHL progress + GI gauge  
- [ ] Notifications — click through to module  
- [ ] Settings — Activity Log  

---

## APPENDIX C — ONE-PARAGRAPH ELEVATOR PITCH (30 seconds)

**Beanthentic Admin is a Flask-based web dashboard that lets Lipa City coffee administrators manage farmer records, process IPOPHL Geographical Indication documents with AI-assisted review, communicate with farmers via messaging, and monitor GI readiness through analytics — all connected to the same Supabase database used by our mobile farmer app and client web store.**

---

*Document generated for thesis defense preparation — Beanthentic Admin module.*  
*Align spoken claims with your actual demo data and panel-approved scope.*
