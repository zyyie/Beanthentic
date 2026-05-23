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

    def __init__(self, uploads_dir: str = "../uploads"):
        self.uploads_dir = Path(uploads_dir)
        self.uploads_dir.mkdir(exist_ok=True)

        # Comprehensive checklist of GI-related terms for extraction
        self.gi_checklist = {
            "mandatory_terms": [
                "Geographical Indication", "GI", "Manual of Specifications", "MoP", 
                "Geographical Area", "Causal Link", "Production Process", "Quality Control",
                "Labeling Rules", "Applicant Entity", "Producers Organization", "LGU",
                "Official Receipt", "Application Fee", "Registrability", "Publication",
                "Opposition", "Certificate of Registration", "Compliance", "Technical Validation",
                "Lipa City", "Batangas", "Barako", "Coffee", "Specifications"
            ],
            "optional_terms": [
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
                "mandatory": ["Identify Qualifying Product", "Geographical Origin", "Lipa Barako coffee", "Product Specifications"],
                "optional": ["Product Photos", "Quality Attributes", "Reputation Evidence"]
            },
            "phase1-entity": {
                "mandatory": ["Applicant Entity", "Producers Organization", "LGU", "Organization Documents"],
                "optional": ["Certificates", "Bylaws", "Membership List"]
            },
            "phase1-stakeholders": {
                "mandatory": ["Stakeholder Consultations", "Industry Groups", "Consensus", "Governance"],
                "optional": ["Meeting Minutes", "Attendance Sheets", "Agreement Documents"]
            },
            # Phase 2: Preparing Application Documents
            "phase2-mop": {
                "mandatory": ["Manual of Specifications", "MoP", "Geographical Area", "Causal Link", "Production Process", "Quality Control", "Labeling Rules"],
                "optional": ["Territorial Boundaries", "Technical Specifications", "Governing Board"]
            },
            "phase2-cert": {
                "mandatory": ["Government Certification", "Independent Certification", "Technical Validation"],
                "optional": ["Foreign Protection", "Proof of Foreign Registration"]
            },
            "phase2-details": {
                "mandatory": ["Application Form", "Applicant Name", "Applicant Address", "Legal Entity", "Domicile"],
                "optional": ["Representative Designation", "Industrial Establishment", "Commercial Establishment"]
            },
            # Phase 3: Filing with IPOPHL
            "phase3-filing": {
                "mandatory": ["File Application", "Bureau of Trademarks", "Application Package", "Cover Letter"],
                "optional": ["Submission Receipt", "Acknowledgment"]
            },
            "phase3-payment": {
                "mandatory": ["Proof of Payment", "Official Receipt", "Application Fee"],
                "optional": ["Exemption Certificate", "Bank Transfer Confirmation"]
            },
            # Phase 4: Examination and Publication
            "phase4-exam": {
                "mandatory": ["Formality Examination", "Substantive Examination", "IP Code Provisions", "Registrability"],
                "optional": ["Examination Reports", "Clarifications"]
            },
            "phase4-response": {
                "mandatory": ["Deficiency Notices", "Response Letters", "Timeframe Compliance"],
                "optional": ["Extensions", "Additional Evidence"]
            },
            "phase4-pub": {
                "mandatory": ["Publication for Opposition", "Third-party Observations", "Public Notice Period"],
                "optional": ["Opposition Filings", "Response to Objections"]
            },
            # Phase 5: Registration and Ongoing Compliance
            "phase5-cert": {
                "mandatory": ["GI Registration Certificate", "Official Notice", "Registration Number"],
                "optional": ["Award Ceremony", "Public Announcement"]
            },
            "phase5-compliance": {
                "mandatory": ["Maintain Standards", "Quality Control", "Compliance Audits", "Monitoring Records"],
                "optional": ["Standards Manual", "Unauthorized Use Prevention"]
            }
        }

        # Initialize or load ML model
        self.model = None
        self.vectorizer = None
        self.column_structure = None
        self.feature_names = None
        self.explainer = None
        
        if ML_AVAILABLE:
            self._initialize_model()

    def _initialize_model(self):
        """Initialize or train the Random Forest model"""
        # Search for model files in the current directory first (where ai_engine.py is)
        current_dir = Path(__file__).parent
        
        model_path = current_dir / "gi_model.joblib"
        vectorizer_path = current_dir / "vectorizer.joblib"
        structure_path = current_dir / "column_structure.json"
        feature_names_path = current_dir / "feature_names.json"

        # Fallback to uploads_dir if not in current directory
        if not model_path.exists():
            model_path = self.uploads_dir / "gi_model.joblib"
            vectorizer_path = self.uploads_dir / "vectorizer.joblib"
            structure_path = self.uploads_dir / "column_structure.json"
            feature_names_path = self.uploads_dir / "feature_names.json"

        if model_path.exists():
            try:
                self.model = joblib.load(model_path)
                logging.info("Loaded existing ML model")
                
                if structure_path.exists():
                    with open(structure_path, 'r') as f:
                        self.column_structure = json.load(f)
                    logging.info("Loaded tabular column structure")
                
                if vectorizer_path.exists():
                    self.vectorizer = joblib.load(vectorizer_path)
                    logging.info("Loaded vectorizer")

                if feature_names_path.exists():
                    with open(feature_names_path, 'r') as f:
                        self.feature_names = json.load(f)
                    logging.info("Loaded feature names")
                else:
                    # Construct feature names from checklist if not saved
                    self.feature_names = (['text_length', 'word_count'] + 
                                        self.gi_checklist["mandatory_terms"] + 
                                        self.gi_checklist["optional_terms"])

                # Initialize SHAP explainer
                if hasattr(self.model, 'predict'):
                    self.explainer = shap.TreeExplainer(self.model)
                    logging.info("Initialized SHAP TreeExplainer")
                    
            except Exception as e:
                logging.warning(f"Failed to load model or initialize SHAP: {e}")
                self._create_default_model()
        else:
            self._create_default_model()

    def _generate_shap_explanation(self, features: List, readiness_score: int, task_id: str = None) -> str:
        """Generate an in-depth SHAP analysis in paragraph form with 3 paragraphs"""
        if not self.explainer or not self.feature_names:
            return "Detailed AI analysis is currently unavailable. Please ensure all ML dependencies are installed."

        try:
            # Get SHAP values for the features
            shap_values = self.explainer.shap_values(np.array([features]))
            
            # Link SHAP values with feature names
            if isinstance(shap_values, list):
                instance_shap = shap_values[1][0]
            else:
                instance_shap = shap_values[0, :, 1] if len(shap_values.shape) == 3 else shap_values[0]

            feature_impact = []
            for i, val in enumerate(instance_shap):
                if i < len(self.feature_names):
                    feature_impact.append({'name': self.feature_names[i], 'impact': val})

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

    def _create_default_model(self):
        """Create a default rule-based model"""
        # Simple rule-based classifier using keyword matching
        self.model = "rule_based"
        self.vectorizer = None
        self.column_structure = None
        logging.info("Using rule-based analysis")

    def analyze_farmer_profile(self, profile_data: Dict) -> Dict:
        """Analyze a farmer's GI readiness based on profile data"""
        if self.model == "rule_based" or self.column_structure is None:
            return {
                "success": False,
                "error": "ML model not trained for tabular data analysis"
            }

        try:
            import pandas as pd
            # Create a DataFrame from the profile data
            df = pd.DataFrame([profile_data])
            
            # Reorder and encode to match training structure
            # 1. Ensure all original columns are present (fill missing with defaults)
            for col in self.column_structure['original_cols']:
                if col not in df.columns:
                    df[col] = 0 if 'masl' in col or 'pH' in col or 'mm' in col or 'C' in col or 'yield' in col or 'count' in col or 'trees' in col or 'pct' in col or 'years' in col else 'Unknown'

            # 2. One-hot encode categorical columns
            df_encoded = pd.get_dummies(df, columns=self.column_structure['categorical_cols'])
            
            # 3. Align with training encoded columns (add missing columns as 0, drop extra)
            for col in self.column_structure['encoded_cols']:
                if col not in df_encoded.columns:
                    df_encoded[col] = 0
            
            df_final = df_encoded[self.column_structure['encoded_cols']]
            
            # Make prediction
            probability = self.model.predict_proba(df_final.values)[0]
            readiness_score = int(probability[1] * 100)
            status = "Ready" if readiness_score >= 75 else "Not Ready"
            
            # Determine which features contributed most (simplified)
            detected_features = []
            for col, val in profile_data.items():
                if val == "Yes" or (isinstance(val, (int, float)) and val > 0):
                    detected_features.append(col)

            return {
                "success": True,
                "readiness_score": readiness_score,
                "status": status,
                "detected_features": detected_features,
                "analysis_method": "ml_tabular"
            }
        except Exception as e:
            logging.error(f"Farmer profile analysis failed: {e}")
            return {"success": False, "error": str(e)}

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

            # Perform analysis
            if self.model == "rule_based":
                return self._rule_based_analysis(text, checklist)
            else:
                return self._ml_analysis(text, checklist, task_id)

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
            if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower):
                detected_mandatory.append(term)
            else:
                missing_mandatory.append(term)

        # Check for optional terms
        detected_optional = []
        for term in checklist["optional_terms"]:
            if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower):
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
            p1 += "The document demonstrates strong compliance with IPOPHL standards, showing a consistent use of technical terminology required for Geographical Indication registration.</p>"
        else:
            p1 += "Current findings indicate that the document lacks several critical structural elements and key legal terms that are essential for a successful GI application process.</p>"

        p2 = "<p>A detailed review of the missing components reveals that the following areas require immediate attention: "
        if missing_mandatory:
            p2 += f"<strong>{', '.join(missing_mandatory[:3])}</strong> and other related technical specifications. "
        p2 += "The absence of these specific identifiers may lead to formality examination deficiencies, as they are necessary to establish the unique link between Lipa Barako coffee and its geographical origin.</p>"

        p3 = "<p>To improve this document's standing, it is recommended to explicitly integrate the missing mandatory requirements and expand on the production processes unique to the Batangas region. "
        p3 += "Ensuring that the Manual of Specifications (MoP) is fully detailed will help achieve a higher compliance score and facilitate a smoother approval workflow with IPOPHL.</p>"

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

    def _ml_analysis(self, text: str, checklist: Dict = None, task_id: str = None) -> Dict:
        """ML-based analysis using Random Forest"""
        if checklist is None:
            checklist = self.gi_checklist
            
        try:
            # Feature extraction (uses the standard checklist for ML features if model was trained on them)
            # Note: The ML model expects features based on the standard checklist
            features = self._extract_features(text)

            # Make prediction
            if hasattr(self.model, 'predict_proba'):
                probability = self.model.predict_proba([features])[0]
                readiness_score = int(probability[1] * 100)  # Probability of "ready" class
            else:
                readiness_score = 75  # Default fallback

            # Determine status
            status = "Ready" if readiness_score >= 75 else "Not Ready"

            # Extract detected and missing terms using the provided checklist for the report
            detected_features, missing_requirements = self._analyze_terms(text, checklist)

            # Generate SHAP explanation
            shap_analysis = self._generate_shap_explanation(features, readiness_score, task_id)

            return {
                "success": True,
                "readiness_score": readiness_score,
                "status": status,
                "detected_features": detected_features,
                "missing_requirements": missing_requirements,
                "text_length": len(text),
                "analysis_method": "ml_based",
                "shap_analysis": shap_analysis
            }

        except Exception as e:
            logging.error(f"ML analysis failed, falling back to rule-based: {e}")
            return self._rule_based_analysis(text, checklist)

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
            features.append(1 if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower) else 0)

        return features

    def _analyze_terms(self, text: str, checklist: Dict = None) -> Tuple[List[str], List[str]]:
        """Analyze which terms are present/missing from checklist"""
        if checklist is None:
            checklist = self.gi_checklist
            
        text_lower = text.lower()

        detected = []
        missing = []

        for term in checklist["mandatory_terms"]:
            if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower):
                detected.append(term)
            else:
                missing.append(term)
        
        # Also check optional terms for "detected"
        for term in checklist["optional_terms"]:
            if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower):
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
