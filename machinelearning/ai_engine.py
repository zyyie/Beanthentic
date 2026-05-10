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
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False
    logging.warning("ML libraries not available, using rule-based analysis")

class GIAnalyzer:
    """AI Engine for IPOPHL GI Registration and Farmer Readiness Analysis"""

    def __init__(self, uploads_dir: str = "../uploads"):
        self.uploads_dir = Path(uploads_dir)
        self.uploads_dir.mkdir(exist_ok=True)

        # GI Seal Application Checklist - Updated as per IPOPHL requirements
        self.gi_checklist = {
            "mandatory_terms": [
                "Application Form", "Manual of Specifications", "MoP",
                "Geographical Area", "Causal Link", "Production Process",
                "Quality Control", "Labeling Rules", "Government Certification",
                "Proof of Payment", "Applicant Name", "Applicant Address",
                "Legal Entity", "Domicile", "Geographical Origin"
            ],
            "optional_terms": [
                "Foreign Protection", "Representative Designation", 
                "Independent Certification", "Industrial Establishment",
                "Commercial Establishment", "Stakeholders", "Governing Board",
                "Territorial Boundaries", "Technical Specifications"
            ]
        }

        # Task-specific checklists based on IPOPHL requirements
        self.task_checklists = {
            "phase2-mop": {
                "mandatory": ["Manual of Specifications", "MoP", "Geographical Area", "Causal Link", "Production Process", "Quality Control", "Labeling Rules"],
                "optional": ["Territorial Boundaries", "Technical Specifications", "Governing Board"]
            },
            "phase2-cert": {
                "mandatory": ["Government Certification", "Independent Certification"],
                "optional": ["Foreign Protection", "Proof of Foreign Registration"]
            },
            "phase2-details": {
                "mandatory": ["Application Form", "Applicant Name", "Applicant Address", "Legal Entity", "Domicile"],
                "optional": ["Representative Designation", "Industrial Establishment", "Commercial Establishment"]
            },
            "phase3-payment": {
                "mandatory": ["Proof of Payment", "Official Receipt", "Application Fee"],
                "optional": ["Exemption Certificate"]
            }
        }

        # Initialize or load ML model
        self.model = None
        self.vectorizer = None
        self.column_structure = None
        
        if ML_AVAILABLE:
            self._initialize_model()

    def _initialize_model(self):
        """Initialize or train the Random Forest model"""
        # Search for model files in the current directory first (where ai_engine.py is)
        current_dir = Path(__file__).parent
        
        model_path = current_dir / "gi_model.joblib"
        vectorizer_path = current_dir / "vectorizer.joblib"
        structure_path = current_dir / "column_structure.json"

        # Fallback to uploads_dir if not in current directory
        if not model_path.exists():
            model_path = self.uploads_dir / "gi_model.joblib"
            vectorizer_path = self.uploads_dir / "vectorizer.joblib"
            structure_path = self.uploads_dir / "column_structure.json"

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
                    
            except Exception as e:
                logging.warning(f"Failed to load model: {e}")
                self._create_default_model()
        else:
            self._create_default_model()

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
                return self._ml_analysis(text, checklist)

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

        return {
            "success": True,
            "readiness_score": readiness_score,
            "status": status,
            "detected_features": detected_mandatory + detected_optional,
            "missing_requirements": missing_mandatory,
            "text_length": len(text),
            "analysis_method": "rule_based"
        }

    def _ml_analysis(self, text: str, checklist: Dict = None) -> Dict:
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

            return {
                "success": True,
                "readiness_score": readiness_score,
                "status": status,
                "detected_features": detected_features,
                "missing_requirements": missing_requirements,
                "text_length": len(text),
                "analysis_method": "ml_based"
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
