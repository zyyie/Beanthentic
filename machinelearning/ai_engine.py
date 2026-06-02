"""
AI Engine for IPOPHL GI Document Analysis.

This module provides text extraction and analysis capabilities for
IPOPHL Geographical Indication registration documents using both
rule-based and machine learning approaches.
"""

import logging
import re
import uuid
import json
from pathlib import Path
from typing import Dict, List, Tuple

# Text extraction libraries
try:
    import fitz  # PyMuPDF
    PDF_AVAILABLE = True
except ImportError:
    PDF_AVAILABLE = False
    logging.warning("PyMuPDF not available, PDF processing will be limited")

try:
    import docx
    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False
    logging.warning("python-docx not available, Word document processing will be limited")

try:
    import pytesseract
    from PIL import Image
    import io
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False
    logging.warning("Tesseract OCR not available, scanned PDF processing will be limited")

# ML libraries
try:
    import joblib
    import pandas as pd
    import numpy as np
    import shap
    import matplotlib.pyplot as plt
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False
    logging.warning("ML libraries (shap, pandas, numpy, etc.) not available, using rule-based analysis")

class GIAnalyzer:
    """AI Engine for IPOPHL GI Registration and Farmer Readiness Analysis"""

    def __init__(self, uploads_dir: str | None = None):
        self.ml_dir = Path(__file__).resolve().parent
        self.uploads_dir = Path(uploads_dir) if uploads_dir else (self.ml_dir / "uploads")
        self.uploads_dir.mkdir(parents=True, exist_ok=True)

        # Comprehensive checklist of GI-related terms for extraction
        self.gi_checklist = {
            "mandatory_terms": [
                "MoP", "Manual of Specifications", "Causal Link", "Production Process", 
                "Quality Control", "Labeling Rules", "Applicant Entity", "Producers Organization", 
                "Official Receipt", "Application Fee", "Registrability", "Publication",
                "Opposition", "Technical Validation", "Geographical Indication", "GI",
                "Lipa City", "Batangas", "Barako", "Coffee"
            ],
            "optional_terms": [
                "Geographical Area", "LGU", "Organization Documents", "Certificates", "Bylaws",
                "Membership List", "Meeting Minutes", "Attendance Sheets", "Agreement Documents",
                "Territorial Boundaries", "Soil Composition", "Climate Factors", "Historical Reputation",
                "Traditional Knowledge", "Processing Method", "Packaging", "Governing Board",
                "Third-party Observation", "Foreign Protection", "Prior Use", "Distinctive Quality",
                "Flavor Profile", "Aroma", "Roasting Process", "Farming Practices"
            ]
        }

        # Task-specific checklists based on IPOPHL requirements (Total 13 documents)
        self.task_checklists = {
            # Phase 1: Pre-Application Groundwork
            "phase1-product": {
                "mandatory": ["Lipa Barako coffee", "Flavor Profile", "Geographical Origin", "Distinctive Quality"],
                "optional": ["Product Photos", "Aroma", "Roasting Process", "Farming Practices"]
            },
            "phase1-entity": {
                "mandatory": ["Applicant Entity", "Producers Organization", "Legal Standing", "Membership List"],
                "optional": ["LGU", "Certificates", "Bylaws", "Organization Structure"]
            },
            "phase1-stakeholders": {
                "mandatory": ["Stakeholder Consultations", "Meeting Minutes", "Consensus", "Governance Board"],
                "optional": ["Attendance Sheets", "Agreement Documents", "Industry Groups", "Community Support"]
            },
            # Phase 2: Preparing Application Documents
            "phase2-mop": {
                "mandatory": ["Manual of Specifications", "Causal Link", "Production Process", "Quality Control", "Labeling Rules"],
                "optional": ["Geographical Area", "Territorial Boundaries", "Soil Composition", "Climate Factors"]
            },
            "phase2-cert": {
                "mandatory": ["Technical Validation", "Government Certification", "Independent Verification"],
                "optional": ["Foreign Protection", "Proof of Foreign Registration", "Prior Use Evidence"]
            },
            "phase2-details": {
                "mandatory": ["Application Form", "Applicant Name", "Domicile", "Industrial Establishment"],
                "optional": ["Representative Designation", "Commercial Establishment", "Contact Details"]
            },
            # Phase 3: Filing with IPOPHL
            "phase3-filing": {
                "mandatory": ["File Application", "Bureau of Trademarks", "Application Package", "Cover Letter"],
                "optional": ["Submission Receipt", "Acknowledgment", "Tracking Number"]
            },
            "phase3-payment": {
                "mandatory": ["Official Receipt", "Application Fee", "Proof of Payment"],
                "optional": ["Exemption Certificate", "Bank Transfer Confirmation", "Payment Date"]
            },
            # Phase 4: Examination and Publication
            "phase4-exam": {
                "mandatory": ["Formality Examination", "Substantive Examination", "IP Code Compliance"],
                "optional": ["Examination Reports", "Clarifications", "Technical Responses"]
            },
            "phase4-response": {
                "mandatory": ["Deficiency Notice Response", "Timeframe Compliance", "Corrective Actions"],
                "optional": ["Extensions", "Additional Evidence", "Revised Documents"]
            },
            "phase4-pub": {
                "mandatory": ["Publication for Opposition", "Public Notice Period", "Opposition Period"],
                "optional": ["Third-party Observations", "Opposition Filings", "Response to Objections"]
            },
            # Phase 5: Registration and Ongoing Compliance
            "phase5-cert": {
                "mandatory": ["GI Registration Certificate", "Official Notice of Registration", "Registration Number"],
                "optional": ["Award Ceremony", "Public Announcement", "Marketing Materials"]
            },
            "phase5-compliance": {
                "mandatory": ["Maintain Quality Standards", "Regular Compliance Audits", "Monitoring Records"],
                "optional": ["Standards Manual", "Unauthorized Use Prevention", "Renewal Schedule"]
            }
        }

        # Farmer tabular model (GI readiness from farm profile fields)
        self.farmer_model = None
        self.column_structure = None
        self.farmer_feature_names = None

        # Document analysis uses rules unless a separate document model is added
        self.document_model = None
        self.document_feature_names = None
        self.explainer = None

        # Synonyms help match real IPOPHL uploads (authorization letters, receipts, etc.)
        self._term_synonyms = {
            "manual of specifications": ["manual of specification", "mop", "specifications manual"],
            "causal link": ["causal relationship", "link between", "geographical area and"],
            "production process": ["production method", "processing method", "cultivation"],
            "quality control": ["quality standards", "quality assurance", "qc "],
            "labeling rules": ["labelling", "label requirements", "packaging rules"],
            "applicant entity": ["applicant", "organization", "association", "cooperative"],
            "producers organization": ["producers", "farmers association", "growers", "membership"],
            "legal standing": ["authorization", "authorized", "hereby authorize", "legal capacity", "representative"],
            "membership list": ["members", "member list", "roster", "directory"],
            "stakeholder consultations": ["stakeholder", "consultation", "public hearing"],
            "meeting minutes": ["minutes of meeting", "minutes of the", "meeting held"],
            "consensus": ["agreed", "unanimous", "resolution"],
            "governance board": ["board of directors", "governing board", "board resolution"],
            "technical validation": ["technical certification", "validated by", "certified by"],
            "government certification": ["department of agriculture", "bureau of", "da ", "certified"],
            "independent verification": ["third party", "independent", "verified by"],
            "application form": ["application for", "duly accomplished", "application to register"],
            "applicant name": ["name of applicant", "applicant’s name", "applicant's name"],
            "domicile": ["address", "residence", "located at", "domiciled"],
            "industrial establishment": ["establishment", "place of business", "office at"],
            "file application": ["filed application", "filing", "submit application", "submitted"],
            "bureau of trademarks": ["ipophl", "intellectual property", "bureau of trademark"],
            "application package": ["application documents", "complete application", "submission package"],
            "cover letter": ["letter of transmittal", "transmittal letter"],
            "official receipt": ["official receipt", "or number", "receipt no"],
            "application fee": ["filing fee", "payment of fee", "registration fee"],
            "proof of payment": ["proof of payment", "paid", "payment confirmation", "bank transfer"],
            "formality examination": ["formality", "formal examination"],
            "substantive examination": ["substantive", "substance examination"],
            "ip code compliance": ["intellectual property code", "ip code", "republic act"],
            "deficiency notice response": ["deficiency", "response to notice", "comply with"],
            "timeframe compliance": ["within the period", "deadline", "days from"],
            "corrective actions": ["corrective action", "remedy", "amended"],
            "publication for opposition": ["publication", "opposition period", "published for opposition"],
            "public notice period": ["public notice", "notice period"],
            "opposition period": ["opposition", "third-party"],
            "gi registration certificate": ["certificate of registration", "registration certificate", "gi certificate"],
            "official notice of registration": ["notice of registration", "registered geographical indication"],
            "registration number": ["reg. no", "registration no", "certificate no"],
            "maintain quality standards": ["quality standards", "maintain quality", "compliance with standards"],
            "regular compliance audits": ["audit", "compliance audit", "inspection"],
            "monitoring records": ["monitoring", "records of", "documentation of"],
            "lipa barako coffee": ["barako", "liberica", "lipa coffee", "batangas coffee"],
            "flavor profile": ["flavor", "taste profile", "cup profile", "aroma"],
            "geographical origin": ["geographical indication", "origin", "lipa city", "batangas", "grown in"],
            "distinctive quality": ["distinctive", "unique quality", "reputation", "characteristic"],
            "geographical indication": ["geographical indication", " gi ", "indication of origin"],
            "gi": ["geographical indication", " gi registration", "protected gi"],
        }

        if ML_AVAILABLE:
            self._initialize_models()
            self._ensure_document_model()

    def _model_paths(self) -> list[Path]:
        names = ("gi_farmer_model.joblib", "gi_model.joblib")
        paths = [self.ml_dir / n for n in names]
        paths.extend(self.uploads_dir / n for n in names)
        return paths

    def _initialize_models(self):
        """Load farmer GI readiness model and optional document model."""
        structure_path = self.ml_dir / "column_structure.json"
        feature_names_path = self.ml_dir / "feature_names.json"

        farmer_model_path = next((p for p in self._model_paths() if p.exists()), None)
        if farmer_model_path:
            try:
                self.farmer_model = joblib.load(farmer_model_path)
                logging.info("Loaded farmer ML model from %s", farmer_model_path.name)
                if structure_path.exists():
                    with open(structure_path, encoding="utf-8") as f:
                        self.column_structure = json.load(f)
                if feature_names_path.exists():
                    with open(feature_names_path, encoding="utf-8") as f:
                        self.farmer_feature_names = json.load(f)
            except Exception as e:
                logging.warning("Failed to load farmer ML model: %s", e)
                self.farmer_model = None

        doc_path = self.ml_dir / "gi_document_model.joblib"
        if doc_path.exists():
            try:
                self.document_model = joblib.load(doc_path)
                self.document_feature_names = (
                    ["text_length", "word_count"]
                    + self.gi_checklist["mandatory_terms"]
                    + self.gi_checklist["optional_terms"]
                )
                # SHAP explainer is created lazily on first explanation (slow to build)
            except Exception as e:
                logging.warning("Failed to load document ML model: %s", e)
                self.document_model = None

    def _ensure_document_model(self) -> None:
        """Train document classifier from bundled samples if missing."""
        doc_path = self.ml_dir / "gi_document_model.joblib"
        if doc_path.exists() or self.document_model is not None:
            return
        try:
            import subprocess
            import sys

            script = self.ml_dir / "train_ai_model.py"
            if not script.exists():
                return
            proc = subprocess.run(
                [sys.executable, str(script), "--train-documents"],
                capture_output=True,
                text=True,
                cwd=str(self.ml_dir),
                timeout=300,
            )
            if proc.returncode == 0:
                self._initialize_models()
                logging.info("Auto-trained document ML model from IPOPHL sample dataset")
            else:
                logging.warning(
                    "Document model auto-train failed: %s",
                    (proc.stderr or proc.stdout or "")[-500:],
                )
        except Exception as e:
            logging.warning("Could not auto-train document model: %s", e)

    def _term_matches(self, text_lower: str, term: str) -> bool:
        """Match mandatory/optional GI terms with phrase and synonym support."""
        term_lower = term.lower().strip()
        if not term_lower:
            return False
        if term_lower in text_lower:
            return True
        if " " not in term_lower:
            if re.search(r"\b" + re.escape(term_lower) + r"\b", text_lower):
                return True
        for synonym in self._term_synonyms.get(term_lower, []):
            syn = synonym.lower().strip()
            if not syn:
                continue
            if syn in text_lower:
                return True
            if " " not in syn and re.search(r"\b" + re.escape(syn) + r"\b", text_lower):
                return True
        return False

    def ml_status(self) -> Dict:
        """Return whether trained models are available."""
        training_path = self.ml_dir / "training_results.json"
        meta = {}
        if training_path.exists():
            try:
                with open(training_path, encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                meta = {}
        return {
            "farmer_model_loaded": self.farmer_model is not None,
            "document_model_loaded": self.document_model is not None,
            "document_analysis_default": (
                "ml_hybrid" if self.document_model else "rule_based"
            ),
            "training": meta,
        }

    def _get_explainer(self):
        """Lazy-load SHAP TreeExplainer for document model."""
        if self.explainer is not None:
            return self.explainer
        if not ML_AVAILABLE or self.document_model is None:
            return None
        try:
            self.explainer = shap.TreeExplainer(self.document_model)
        except Exception as shap_err:
            logging.warning("SHAP explainer unavailable: %s", shap_err)
            self.explainer = None
        return self.explainer

    def _generate_shap_explanation(self, features: List, readiness_score: int, task_id: str = None) -> str:
        """Generate an in-depth SHAP analysis in paragraph form with 3 paragraphs"""
        feature_names = self.document_feature_names or self.farmer_feature_names
        explainer = self._get_explainer()
        if not explainer or not feature_names:
            return "Detailed AI analysis is currently unavailable. Please ensure all ML dependencies are installed."

        try:
            # Get SHAP values for the features
            shap_values = explainer.shap_values(np.array([features]))
            
            # Link SHAP values with feature names
            if isinstance(shap_values, list):
                instance_shap = shap_values[1][0]
            else:
                instance_shap = shap_values[0, :, 1] if len(shap_values.shape) == 3 else shap_values[0]

            feature_impact = []
            for i, val in enumerate(instance_shap):
                if i < len(feature_names):
                    feature_impact.append({'name': feature_names[i], 'impact': val})

            feature_impact.sort(key=lambda x: abs(x['impact']), reverse=True)
            doc_type = task_id.replace('-', ' ').title() if task_id else "Document"
            status = "highly compliant" if readiness_score >= 85 else "conditionally sufficient" if readiness_score >= 70 else "insufficient"
            
            # Paragraph 1: Executive Summary and Model Reasoning
            positives = [f['name'] for f in feature_impact if f['impact'] > 0.05][:3]
            p1 = f"<p>The AI model's comprehensive evaluation of the {doc_type} has determined a status of <strong>{status}</strong>, supported by a calculated readiness score of <strong>{readiness_score}%</strong>. "
            if positives:
                p1 += f"The high confidence in this assessment was primarily driven by the explicit presence of {', '.join(positives[:-1])} and {positives[-1]}, which are identified as key statistical anchors for valid Geographical Indication submissions. These elements provide the foundational data required by the system to validate the document's authenticity and technical depth.</p>"
            else:
                p1 += "The current assessment reflects a lack of critical terminology and structural requirements that the Random Forest model uses to verify compliance with IPOPHL standards.</p>"

            # Paragraph 2: Technical Gap Analysis
            negatives = [f['name'] for f in feature_impact if f['impact'] < -0.05][:4]
            p2 = "<p>A deeper technical analysis of the document's content structure reveals significant variances in expected metadata and descriptive terminology. "
            if negatives:
                p2 += f"Specifically, the absence or weak representation of <strong>{', '.join(negatives[:-1])} and {negatives[-1]}</strong> creates a negative impact on the SHAP interpretation values. In the context of GI registration, these missing components are vital for establishing a legally defensible link between the product's quality and its Batangas origin, and their omission suggests that the document may not yet meet the formality examination criteria.</p>"
            else:
                p2 += "While no major technical gaps were explicitly flagged, the overall density of domain-specific information could be further optimized to ensure a smoother transition through the substantive examination phase of the registration process.</p>"

            # Paragraph 3: Strategic Recommendations
            p3 = "<p>To bridge these identified gaps, it is highly recommended to perform a targeted revision focusing on the explicit documentation of technical specifications and the causal relationship between the Lipa Barako flavor profile and the local soil composition. "
            p3 += "Providing more exhaustive details on the {0} and quality control measures will not only improve the AI readiness score but also significantly reduce the likelihood of receiving deficiency notices from IPOPHL. Once these improvements are integrated, the document should be re-analyzed to verify that all mandatory parameters have been successfully satisfied.</p>".format("production process" if "process" not in [n['name'].lower() for n in feature_impact[:5]] else "labeling rules")

            return p1 + p2 + p3

        except Exception as e:
            logging.error(f"SHAP explanation generation failed: {e}")
            return "<p>An error occurred while generating the detailed AI analysis. The basic score and feature detection are still available.</p>"

    @staticmethod
    def _compliance_status_label(score: int) -> str:
        if score >= 85:
            return "highly compliant"
        if score >= 70:
            return "conditionally sufficient"
        return "insufficient"

    def _align_shap_readiness_text(self, html: str, score: int) -> str:
        """Ensure narrative text uses the same readiness % as the score bar."""
        if not html:
            return html
        score = max(0, min(100, int(score)))
        status_label = self._compliance_status_label(score)
        out = re.sub(
            r"(readiness score of\s*<strong>)\d+(%</strong>)",
            rf"\g<1>{score}\g<2>",
            html,
            flags=re.IGNORECASE,
        )
        out = re.sub(
            r"(initial readiness score of\s*<strong>)\d+(%</strong>)",
            rf"\g<1>{score}\g<2>",
            out,
            flags=re.IGNORECASE,
        )
        out = re.sub(
            r"status of\s*<strong>[^<]*</strong>",
            f"status of <strong>{status_label}</strong>",
            out,
            count=1,
            flags=re.IGNORECASE,
        )
        return out

    def normalize_analysis_payload(self, payload: Dict) -> Dict:
        """Single canonical readiness_score across UI fields and SHAP narrative."""
        if not payload:
            return payload
        normalized = dict(payload)
        score = int(normalized.get("readiness_score") or 0)
        shap = normalized.get("shap_analysis") or ""
        if shap:
            normalized["shap_analysis"] = self._align_shap_readiness_text(shap, score)
        return normalized

    def _encode_farmer_profile(self, profile_data: Dict):
        """Return feature matrix aligned to training columns."""
        if not self.column_structure:
            raise ValueError("Column structure not loaded. Train the model first.")

        df = pd.DataFrame([profile_data])
        for col in self.column_structure["original_cols"]:
            if col not in df.columns:
                if col in ("elevation_masl", "soil_pH", "annual_rainfall_mm", "mean_temperature_C", "annual_yield_kg", "moisture_content_pct", "defect_count_per_300g", "years_in_farming", "bearing_trees", "non_bearing_trees"):
                    df[col] = 0
                else:
                    df[col] = "Unknown"

        df_encoded = pd.get_dummies(df, columns=self.column_structure["categorical_cols"])
        for col in self.column_structure["encoded_cols"]:
            if col not in df_encoded.columns:
                df_encoded[col] = 0
        return df_encoded[self.column_structure["encoded_cols"]]

    def analyze_farmer_profile(self, profile_data: Dict) -> Dict:
        """Analyze a farmer's GI readiness based on profile / tabular data."""
        if self.farmer_model is None or self.column_structure is None:
            return {
                "success": False,
                "error": "Farmer ML model not trained. Run: python train_ai_model.py --train-csv",
            }

        try:
            df_final = self._encode_farmer_profile(profile_data)
            probability = self.farmer_model.predict_proba(df_final.values)[0]
            ready_prob = float(probability[1]) if len(probability) > 1 else float(probability[0])
            readiness_score = int(round(ready_prob * 100))
            status = "Ready" if readiness_score >= 75 else "Not Ready"
            predicted_class = int(self.farmer_model.predict(df_final.values)[0])

            detected_features = [
                col for col, val in profile_data.items()
                if val == "Yes" or (isinstance(val, (int, float)) and val > 0)
            ]

            return {
                "success": True,
                "readiness_score": readiness_score,
                "status": status,
                "gi_ready": bool(predicted_class),
                "probability_ready": round(ready_prob, 4),
                "detected_features": detected_features,
                "analysis_method": "ml_farmer",
            }
        except Exception as e:
            logging.error("Farmer profile analysis failed: %s", e)
            return {"success": False, "error": str(e)}

    def predict_farmers_batch(self, rows: List[Dict]) -> Dict:
        """Predict GI readiness for many farmer records."""
        try:
            from machinelearning.farmer_features import farmer_row_to_ml_features
        except ImportError:
            from farmer_features import farmer_row_to_ml_features

        if self.farmer_model is None:
            return {
                "success": False,
                "error": "Farmer ML model not trained. Run: python train_ai_model.py --train-csv",
                "predictions": [],
            }

        predictions = []
        for idx, row in enumerate(rows):
            features = farmer_row_to_ml_features(row if isinstance(row, dict) else {})
            result = self.analyze_farmer_profile(features)
            predictions.append(
                {
                    "index": idx,
                    "farmer_id": row.get("farmer_id") or row.get("NO.") if isinstance(row, dict) else idx,
                    "readiness_score": result.get("readiness_score", 0),
                    "status": result.get("status", "Not Ready"),
                    "gi_ready": result.get("gi_ready", False),
                    "success": result.get("success", False),
                }
            )

        eligible = sum(1 for p in predictions if p.get("gi_ready"))
        return {
            "success": True,
            "analysis_method": "ml_farmer",
            "total": len(predictions),
            "eligible": eligible,
            "not_eligible": len(predictions) - eligible,
            "predictions": predictions,
        }

    def extract_text_from_file(self, file_path: str) -> str:
        """Extract text from uploaded file"""
        file_path = Path(file_path)

        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        text = ""

        if file_path.suffix.lower() == '.pdf':
            text = self._extract_from_pdf(file_path)
        elif file_path.suffix.lower() in ['.doc', '.docx']:
            text = self._extract_from_docx(file_path)
        elif file_path.suffix.lower() in ['.txt', '.md']:
            text = file_path.read_text(encoding='utf-8', errors='ignore')
        else:
            raise ValueError(f"Unsupported file type: {file_path.suffix}")

        return text

    def _extract_from_pdf(self, file_path: Path) -> str:
        """Extract text from PDF, with OCR fallback"""
        if not PDF_AVAILABLE:
            raise ImportError("PyMuPDF is required for PDF processing")

        text = ""
        try:
            doc = fitz.open(file_path)
            for page in doc:
                page_text = page.get_text()
                text += page_text + "\n"
            doc.close()

            # Check if extracted text is meaningful
            if len(text.strip()) < 50:  # Likely scanned PDF
                if OCR_AVAILABLE:
                    text = self._ocr_pdf(file_path)
                else:
                    logging.warning("PDF appears scanned but OCR not available")

        except Exception as e:
            logging.error(f"Error extracting from PDF: {e}")
            if OCR_AVAILABLE:
                text = self._ocr_pdf(file_path)

        return text

    def _ocr_pdf(self, file_path: Path) -> str:
        """OCR extraction from PDF pages"""
        if not OCR_AVAILABLE:
            return ""

        text = ""
        try:
            doc = fitz.open(file_path)
            for page_num in range(len(doc)):
                page = doc.load_page(page_num)
                pix = page.get_pixmap()
                img_data = pix.tobytes("png")
                img = Image.open(io.BytesIO(img_data))
                page_text = pytesseract.image_to_string(img)
                text += page_text + "\n"
            doc.close()
        except Exception as e:
            logging.error(f"OCR error: {e}")

        return text

    def _extract_from_docx(self, file_path: Path) -> str:
        """Extract text from Word document"""
        if not DOCX_AVAILABLE:
            raise ImportError("python-docx is required for Word document processing")

        text = ""
        try:
            doc = docx.Document(file_path)
            for paragraph in doc.paragraphs:
                text += paragraph.text + "\n"

            # Extract text from tables
            for table in doc.tables:
                for row in table.rows:
                    for cell in row.cells:
                        text += cell.text + " "
                    text += "\n"
        except Exception as e:
            logging.error(f"Error extracting from DOCX: {e}")

        return text

    def analyze_document(self, file_path: str, task_id: str = None) -> Dict:
        """Main analysis function with task-specific context"""
        file_path_obj = Path(file_path)
        
        # If it's a CSV file, process as farmer profile instead of document
        if file_path_obj.suffix.lower() == '.csv':
            try:
                import pandas as pd
                df = pd.read_csv(file_path)
                # Take the first row as a sample for analysis
                if not df.empty:
                    profile_data = df.iloc[0].to_dict()
                    return self.analyze_farmer_profile(profile_data)
                else:
                    return {"success": False, "error": "Empty CSV file"}
            except Exception as e:
                logging.error(f"CSV analysis failed: {e}")
                return {"success": False, "error": f"CSV analysis failed: {str(e)}"}

        try:
            # Extract text
            text = self.extract_text_from_file(file_path)

            # Determine which checklist to use
            checklist = self.gi_checklist
            if task_id in self.task_checklists:
                checklist = {
                    "mandatory_terms": self.task_checklists[task_id]["mandatory"],
                    "optional_terms": self.task_checklists[task_id]["optional"]
                }
                logging.info(f"Using task-specific checklist for: {task_id}")

            rule_result = self._rule_based_analysis(text, checklist)
            if self.document_model is not None:
                ml_result = self._ml_analysis(text, checklist, task_id)
                return self._merge_analysis_results(
                    rule_result, ml_result, text=text, task_id=task_id
                )
            return self.normalize_analysis_payload(rule_result)

        except Exception as e:
            logging.error(f"Analysis error: {e}")
            
            # Fallback checklist
            checklist = self.gi_checklist
            if task_id in self.task_checklists:
                checklist = {
                    "mandatory_terms": self.task_checklists[task_id]["mandatory"],
                    "optional_terms": self.task_checklists[task_id]["optional"]
                }
                
            return {
                "success": False,
                "error": str(e),
                "readiness_score": 0,
                "status": "Not Ready",
                "detected_features": [],
                "missing_requirements": checklist["mandatory_terms"]
            }

    def _rule_based_analysis(self, text: str, checklist: Dict = None) -> Dict:
        """Rule-based analysis using keyword matching"""
        if checklist is None:
            checklist = self.gi_checklist
            
        text_lower = text.lower()

        # Check for mandatory terms
        detected_mandatory = []
        missing_mandatory = []

        for term in checklist["mandatory_terms"]:
            if self._term_matches(text_lower, term):
                detected_mandatory.append(term)
            else:
                missing_mandatory.append(term)

        # Check for optional terms
        detected_optional = []
        for term in checklist["optional_terms"]:
            if self._term_matches(text_lower, term):
                detected_optional.append(term)

        # Calculate readiness score
        mandatory_score = (len(detected_mandatory) / max(1, len(checklist["mandatory_terms"]))) * 70
        optional_score = (len(detected_optional) / max(1, len(checklist["optional_terms"]))) * 30
        readiness_score = min(100, round(mandatory_score + optional_score))

        # Determine status
        status = "Ready" if readiness_score >= 75 else "Not Ready"

        # Generate structured 2-3 paragraph analysis
        p1 = f"<p>The rule-based analysis has identified <strong>{len(detected_mandatory)}</strong> out of <strong>{len(checklist['mandatory_terms'])}</strong> mandatory requirements within this document. This results in an initial readiness score of <strong>{readiness_score}%</strong>. "
        if readiness_score >= 75:
            p1 += "The document demonstrates strong compliance with IPOPHL standards, showing a consistent use of technical terminology required for this specific registration stage.</p>"
        else:
            p1 += "Current findings indicate that the document lacks several critical structural elements and key technical terms that are essential for this part of the Geographical Indication application.</p>"

        p2 = "<p>A detailed review of the missing components reveals that the following areas require immediate attention: "
        if missing_mandatory:
            p2 += f"<strong>{', '.join(missing_mandatory[:3])}</strong> and other related identifiers. "
        p2 += "The absence of these specific requirements may lead to formality examination deficiencies, as they are necessary to validate the document's relevance to the Lipa Barako coffee registration process.</p>"

        p3 = "<p>To improve this document's standing, it is recommended to explicitly integrate the missing mandatory requirements identified above. "
        p3 += "Ensuring that all task-specific details are fully addressed will help achieve a higher compliance score and facilitate a smoother approval workflow with IPOPHL. Once updated, the document should be re-analyzed to verify readiness.</p>"

        return {
            "success": True,
            "readiness_score": readiness_score,
            "status": status,
            "detected_features": detected_mandatory + detected_optional,
            "missing_requirements": missing_mandatory,
            "text_length": len(text),
            "analysis_method": "rule_based",
            "shap_analysis": p1 + p2 + p3
        }

    def _merge_analysis_results(
        self,
        rule_result: Dict,
        ml_result: Dict,
        *,
        text: str = None,
        task_id: str = None,
    ) -> Dict:
        """Combine rule-based term detection with ML readiness probability."""
        rule_score = int(rule_result.get("readiness_score") or 0)
        ml_score = int(ml_result.get("readiness_score") or 0)
        merged_score = min(100, round(0.45 * ml_score + 0.55 * rule_score))
        detected = list(
            dict.fromkeys(
                (rule_result.get("detected_features") or [])
                + (ml_result.get("detected_features") or [])
            )
        )
        missing = [t for t in (rule_result.get("missing_requirements") or []) if t not in detected]
        status = "Ready" if merged_score >= 75 else "Not Ready"

        shap = ""
        if text and self.document_model is not None:
            try:
                features = self._extract_features(text)
                shap = self._generate_shap_explanation(features, merged_score, task_id)
            except Exception as exc:
                logging.warning("Merged SHAP regeneration failed: %s", exc)
                shap = ml_result.get("shap_analysis") or rule_result.get("shap_analysis") or ""
                shap = self._align_shap_readiness_text(shap, merged_score)
        else:
            raw_shap = ml_result.get("shap_analysis") or rule_result.get("shap_analysis") or ""
            shap = self._align_shap_readiness_text(raw_shap, merged_score) if raw_shap else ""

        return self.normalize_analysis_payload({
            "success": True,
            "readiness_score": merged_score,
            "status": status,
            "detected_features": detected,
            "missing_requirements": missing,
            "text_length": rule_result.get("text_length") or ml_result.get("text_length") or 0,
            "analysis_method": "ml_hybrid",
            "shap_analysis": shap,
            "ml_score": ml_score,
            "rule_score": rule_score,
        })

    def _ml_analysis(self, text: str, checklist: Dict = None, task_id: str = None) -> Dict:
        """ML-based analysis using Random Forest"""
        if checklist is None:
            checklist = self.gi_checklist
            
        try:
            features = self._extract_features(text)

            if hasattr(self.document_model, "predict_proba"):
                probability = self.document_model.predict_proba([features])[0]
                ready_idx = 1 if len(probability) > 1 else 0
                readiness_score = int(round(float(probability[ready_idx]) * 100))
            else:
                readiness_score = int(self.document_model.predict([features])[0] * 100)

            status = "Ready" if readiness_score >= 75 else "Not Ready"
            detected_features, missing_requirements = self._analyze_terms(text, checklist)
            shap_analysis = self._generate_shap_explanation(features, readiness_score, task_id)

            return self.normalize_analysis_payload({
                "success": True,
                "readiness_score": readiness_score,
                "status": status,
                "detected_features": detected_features,
                "missing_requirements": missing_requirements,
                "text_length": len(text),
                "analysis_method": "ml_based",
                "shap_analysis": shap_analysis,
            })

        except Exception as e:
            logging.error(f"ML analysis failed, falling back to rule-based: {e}")
            return self.normalize_analysis_payload(self._rule_based_analysis(text, checklist))

    def _extract_features(self, text: str) -> List:
        """Extract ML features from text based on standard checklist"""
        features = []

        # Text length features
        features.append(len(text))
        features.append(len(text.split()))

        # Keyword presence features (always use global checklist for consistent ML features)
        all_terms = self.gi_checklist["mandatory_terms"] + self.gi_checklist["optional_terms"]
        text_lower = text.lower()

        for term in all_terms:
            features.append(1 if self._term_matches(text_lower, term) else 0)

        return features

    def _analyze_terms(self, text: str, checklist: Dict = None) -> Tuple[List[str], List[str]]:
        """Analyze which terms are present/missing from checklist"""
        if checklist is None:
            checklist = self.gi_checklist
            
        text_lower = text.lower()

        detected = []
        missing = []

        for term in checklist["mandatory_terms"]:
            if self._term_matches(text_lower, term):
                detected.append(term)
            else:
                missing.append(term)
        
        # Also check optional terms for "detected"
        for term in checklist["optional_terms"]:
            if self._term_matches(text_lower, term):
                detected.append(term)

        return detected, missing

    def save_uploaded_file(self, file_data, filename: str) -> str:
        """Save uploaded file with UUID naming"""
        # Generate unique filename
        file_uuid = str(uuid.uuid4())
        file_ext = Path(filename).suffix
        safe_filename = f"{file_uuid}{file_ext}"

        # Save file
        file_path = self.uploads_dir / safe_filename
        if hasattr(file_data, 'save'):
            file_data.save(str(file_path))
        else:
            with open(file_path, 'wb') as f:
                f.write(file_data)

        return str(file_path)

    def get_file_preview_url(self, file_path: str) -> str:
        """Get URL for file preview"""
        return f"/api/file-preview/{Path(file_path).name}"

# Global instance
gi_analyzer = GIAnalyzer()
