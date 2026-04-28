import os
import uuid
import json
import re
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import logging

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
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.feature_extraction.text import TfidfVectorizer
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False
    logging.warning("ML libraries not available, using rule-based analysis")

class GIAnalyzer:
    """AI Engine for IPOPHL GI Registration Document Analysis"""
    
    def __init__(self, uploads_dir: str = "../uploads"):
        self.uploads_dir = Path(uploads_dir)
        self.uploads_dir.mkdir(exist_ok=True)
        
        # GI Checklist for Lipa City Coffee
        self.gi_checklist = {
            "mandatory_terms": [
                "Lipa", "Batangas", "coffee", "Barako",
                "altitude", "soil", "climate", "geographical",
                "origin", "quality", "reputation", "traditional",
                "cultivation", "harvesting", "processing", "notary",
                "certification", "specifications", "standards"
            ],
            "optional_terms": [
                "farmers", "cooperative", "association", "LGU",
                "production", "yield", "variety", "arabica",
                "robusta", "excelsa", "liberica", "organoleptic",
                "characteristics", "distinctive", "method", "practice"
            ]
        }
        
        # Initialize or load ML model
        self.model = None
        self.vectorizer = None
        if ML_AVAILABLE:
            self._initialize_model()
    
    def _initialize_model(self):
        """Initialize or train the Random Forest model"""
        model_path = self.uploads_dir / "gi_model.joblib"
        vectorizer_path = self.uploads_dir / "vectorizer.joblib"
        
        if model_path.exists() and vectorizer_path.exists():
            try:
                self.model = joblib.load(model_path)
                self.vectorizer = joblib.load(vectorizer_path)
                logging.info("Loaded existing ML model")
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
        logging.info("Using rule-based analysis")
    
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
    
    def analyze_document(self, file_path: str) -> Dict:
        """Main analysis function"""
        try:
            # Extract text
            text = self.extract_text_from_file(file_path)
            
            # Perform analysis
            if self.model == "rule_based":
                return self._rule_based_analysis(text)
            else:
                return self._ml_analysis(text)
                
        except Exception as e:
            logging.error(f"Analysis error: {e}")
            return {
                "success": False,
                "error": str(e),
                "readiness_score": 0,
                "status": "Not Ready",
                "detected_features": [],
                "missing_requirements": self.gi_checklist["mandatory_terms"]
            }
    
    def _rule_based_analysis(self, text: str) -> Dict:
        """Rule-based analysis using keyword matching"""
        text_lower = text.lower()
        
        # Check for mandatory terms
        detected_mandatory = []
        missing_mandatory = []
        
        for term in self.gi_checklist["mandatory_terms"]:
            if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower):
                detected_mandatory.append(term)
            else:
                missing_mandatory.append(term)
        
        # Check for optional terms
        detected_optional = []
        for term in self.gi_checklist["optional_terms"]:
            if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower):
                detected_optional.append(term)
        
        # Calculate readiness score
        mandatory_score = (len(detected_mandatory) / len(self.gi_checklist["mandatory_terms"])) * 70
        optional_score = (len(detected_optional) / len(self.gi_checklist["optional_terms"])) * 30
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
    
    def _ml_analysis(self, text: str) -> Dict:
        """ML-based analysis using Random Forest"""
        try:
            # Feature extraction
            features = self._extract_features(text)
            
            # Make prediction
            if hasattr(self.model, 'predict_proba'):
                probability = self.model.predict_proba([features])[0]
                readiness_score = int(probability[1] * 100)  # Probability of "ready" class
            else:
                readiness_score = 75  # Default fallback
            
            # Determine status
            status = "Ready" if readiness_score >= 75 else "Not Ready"
            
            # Extract detected and missing terms
            detected_features, missing_requirements = self._analyze_terms(text)
            
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
            return self._rule_based_analysis(text)
    
    def _extract_features(self, text: str) -> List:
        """Extract ML features from text"""
        features = []
        
        # Text length features
        features.append(len(text))
        features.append(len(text.split()))
        
        # Keyword presence features
        all_terms = self.gi_checklist["mandatory_terms"] + self.gi_checklist["optional_terms"]
        text_lower = text.lower()
        
        for term in all_terms:
            features.append(1 if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower) else 0)
        
        return features
    
    def _analyze_terms(self, text: str) -> Tuple[List[str], List[str]]:
        """Analyze which terms are present/missing"""
        text_lower = text.lower()
        
        detected = []
        missing = []
        
        all_terms = self.gi_checklist["mandatory_terms"] + self.gi_checklist["optional_terms"]
        for term in self.gi_checklist["mandatory_terms"]:
            if re.search(r'\b' + re.escape(term.lower()) + r'\b', text_lower):
                detected.append(term)
            else:
                missing.append(term)
        
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
