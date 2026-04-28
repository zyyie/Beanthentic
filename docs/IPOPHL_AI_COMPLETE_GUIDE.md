# IPOPHL GI Registration - Complete AI Integration Guide

## 🎯 Overview

This comprehensive guide covers the AI-powered document analysis system for the IPOPHL (Intellectual Property Office of the Philippines) GI Registration module. The system automatically analyzes uploaded documents for GI readiness using text extraction, keyword matching, and machine learning techniques.

## ✨ Features

### 🤖 AI Analysis Engine
- **Text Extraction**: Supports PDF, Word (.doc/.docx), and text files
- **OCR Fallback**: Automatic OCR for scanned PDFs using Tesseract
- **Random Forest Classifier**: ML-based document readiness scoring
- **Rule-Based Fallback**: Keyword matching when ML models aren't available

### 📊 Real-time Analysis Panel
- **GI Process Indicator**: Visual readiness score (0-100%)
- **Detected Features**: Green checkmarks for found GI terms
- **Missing Requirements**: Red warnings for mandatory terms
- **Live Updates**: Real-time analysis refresh capability

### 📁 File Previewer
- **Side-by-Side View**: Document preview alongside AI analysis
- **PDF.js Integration**: Native PDF rendering in browser
- **Secure Preview**: UUID-based file serving with access controls

### 🔐 Security & Storage
- **UUID File Naming**: Prevents directory traversal attacks
- **Secure Upload**: File type validation and size limits
- **Database Storage**: Analysis metadata and file tracking
- **Activity Logging**: Complete audit trail

## 🏗️ Architecture

### Backend Components

#### 1. AI Engine (`ai_engine.py`)
```python
class GIAnalyzer:
    - extract_text_from_file()
    - analyze_document()
    - save_uploaded_file()
```

**Text Processing Pipeline:**
1. File type detection
2. Text extraction (PyMuPDF for PDFs, python-docx for Word)
3. OCR fallback for scanned documents
4. Feature extraction and analysis
5. Readiness scoring

#### 2. Database Schema (`models.py`)
```sql
CREATE TABLE document_analysis (
    id INTEGER PRIMARY KEY,
    file_uuid VARCHAR(36) UNIQUE,
    original_filename VARCHAR(255),
    file_path VARCHAR(500),
    file_type VARCHAR(50),
    file_size INTEGER,
    ai_score INTEGER DEFAULT 0,
    ai_status VARCHAR(20) DEFAULT 'Not Ready',
    detected_features TEXT,  -- JSON
    missing_requirements TEXT,  -- JSON
    analysis_method VARCHAR(50),
    text_length INTEGER,
    upload_timestamp DATETIME,
    analysis_timestamp DATETIME,
    ipophl_phase VARCHAR(50),
    task_id VARCHAR(100)
);
```

#### 3. API Routes (`web.py`)
- `POST /api/ipo-analyze` - Upload and analyze documents
- `GET /api/file-preview/<filename>` - Serve files for preview
- `GET /api/ipo-analysis/<file_uuid>` - Get analysis results
- `POST /api/ipo-analysis/<file_uuid>` - Refresh analysis
- `GET /api/ipo-documents` - List all analyzed documents

### Frontend Components

#### 1. File Previewer Modal
- Split-screen layout (document + analysis)
- Responsive design for mobile devices
- Loading states and error handling

#### 2. AI Analysis Panel
- Progress indicator with color coding
- Feature detection lists
- Metadata display
- Refresh functionality

#### 3. Enhanced File Upload
- Drag-and-drop support
- Real-time analysis feedback
- Score badges on uploaded files

## 📋 GI Checklist

The AI analyzes documents against this Lipa City Coffee GI checklist:

### Mandatory Terms (70% weight)
- "Lipa", "Batangas", "coffee", "Barako"
- "altitude", "soil", "climate", "geographical"
- "origin", "quality", "reputation", "traditional"
- "cultivation", "harvesting", "processing", "notary"
- "certification", "specifications", "standards"

### Optional Terms (30% weight)
- "farmers", "cooperative", "association", "LGU"
- "production", "yield", "variety", "arabica"
- "robusta", "excelsa", "liberica", "organoleptic"
- "characteristics", "distinctive", "method", "practice"

## 🎯 Scoring Algorithm

### Rule-Based Scoring
```
readiness_score = (mandatory_found / mandatory_total) * 70 + 
                  (optional_found / optional_total) * 30
```

### Status Determination
- **Ready**: Score ≥ 75%
- **Not Ready**: Score < 75%

## 🚀 Installation & Setup

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Install Tesseract OCR (for scanned PDFs)
**Windows:**
```bash
# Download installer from: https://github.com/UB-Mannheim/tesseract/wiki
# Add to PATH during installation
```

**macOS:**
```bash
brew install tesseract
```

**Linux:**
```bash
sudo apt-get install tesseract-ocr
```

### 3. Database Migration
The new `document_analysis` table will be created automatically when the app starts.

### 4. File Storage
Create the uploads directory:
```bash
mkdir uploads
```

## 🎓 AI Model Training

### Quick Start with Sample Data
```bash
cd machinelearning
python train_ai_model.py --full-pipeline
```

### Training with Real Datasets

#### Step 1: Prepare Training Data
```bash
# Create dataset template
cd machinelearning
python train_ai_model.py --create-template
```

**Dataset Format** (`training_data/gi_documents_raw.json`):
```json
[
  {
    "text": "Full document text content...",
    "label": "Ready",  // or "Not Ready"
    "score": 85,  // 0-100 readiness score
    "source": "manual",  // or "scraped", "generated"
    "notes": "Optional notes about this document"
  }
]
```

#### Step 2: Train Model
```bash
# Full pipeline
cd machinelearning
python train_ai_model.py --full-pipeline

# Step-by-step
python train_ai_model.py --prepare-data
python train_ai_model.py --train
python train_ai_model.py --evaluate
```

### Data Collection Strategy

**High-Quality Sources**:
- Real IPOPHL applications (approved/rejected)
- Government certifications (Department of Agriculture, LGU)
- Farmer cooperative documents (bylaws, certifications)
- Technical specifications (soil analysis, altitude data)

**Target Dataset Size**:
- **Minimum**: 50 documents (25 Ready, 25 Not Ready)
- **Good**: 100+ documents (balanced classes)
- **Excellent**: 200+ documents with diverse sources

### Expected Performance with Real Data

**With 100+ Quality Documents**:
- **Target Accuracy**: 85-95%
- **Cross-validation**: 5-fold CV stability
- **Feature Importance**: Clear GI term patterns

## 📖 Usage Guide

### For Users

1. **Navigate to IPOPHL Module**
   - Click "IPOPHL" in the sidebar
   - Select any phase (1-5)

2. **Upload Documents**
   - Drag files to upload zones or click to browse
   - Supported formats: PDF, Word, Text
   - AI analysis runs automatically

3. **View Analysis**
   - Click "Preview & Analysis" on uploaded files
   - Review readiness score and detected features
   - Check missing requirements list

4. **Refresh Analysis**
   - Click "Refresh Analysis" button in preview
   - Useful after updating documents or models

### For Developers

#### API Usage Examples

**Upload and Analyze:**
```javascript
const formData = new FormData();
formData.append('file', fileInput.files[0]);
formData.append('phase', 'phase1');
formData.append('task_id', 'product');

fetch('/api/ipo-analyze', {
    method: 'POST',
    body: formData
})
.then(response => response.json())
.then(data => console.log(data));
```

**Get Analysis Results:**
```javascript
fetch('/api/ipo-analysis/uuid-here')
.then(response => response.json())
.then(data => console.log(data.analysis));
```

#### Customizing the AI Model

**Training a New Model:**
```python
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
import joblib

# Prepare training data
X_train = ["document texts..."]
y_train = [0, 1, 1, 0]  # 0=Not Ready, 1=Ready

# Train model
vectorizer = TfidfVectorizer(max_features=1000)
X_train_vec = vectorizer.fit_transform(X_train)

model = RandomForestClassifier(n_estimators=100, random_state=42)
model.fit(X_train_vec, y_train)

# Save model
joblib.dump(model, 'uploads/gi_model.joblib')
joblib.dump(vectorizer, 'uploads/vectorizer.joblib')
```

**Adding New GI Terms:**
```python
# In ai_engine.py
self.gi_checklist = {
    "mandatory_terms": [
        # Add new terms here
        "new_mandatory_term",
        # ... existing terms
    ],
    "optional_terms": [
        # Add new terms here
        "new_optional_term",
        # ... existing terms
    ]
}
```

## 🔒 Security Considerations

### File Upload Security
- UUID-based filenames prevent path traversal
- File type validation restricts to allowed formats
- File size limits prevent DoS attacks
- Secure file serving with authentication checks

### Data Protection
- All file access requires authenticated session
- Database stores file metadata, not content
- Activity logging tracks all analysis operations
- Input validation on all API endpoints

## 🐛 Troubleshooting

### Common Issues

**1. "PyMuPDF not available" Error**
```bash
pip install PyMuPDF
```

**2. OCR Not Working**
- Install Tesseract OCR
- Ensure it's in system PATH
- Test with: `tesseract --version`

**3. Database Migration Issues**
- Restart the Flask app
- Check database connection
- Verify SQLAlchemy configuration

**4. File Preview Not Loading**
- Check file permissions in uploads folder
- Verify file exists with correct UUID
- Check browser console for errors

### Debug Mode
Enable debug logging in `ai_engine.py`:
```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

## ⚡ Performance Optimization

### Caching
- Analysis results cached in database
- File preview served directly from filesystem
- Consider Redis for session caching

### Scalability
- Async file processing for large documents
- Queue system for batch analysis
- CDN for static file serving

## 🔄 Continuous Learning Pipeline

### Active Learning Loop
1. **Collect User Feedback**: Correct/incorrect predictions
2. **Identify Uncertain Cases**: Low confidence predictions
3. **Expert Review**: Human validation of edge cases
4. **Model Retraining**: Monthly updates with new data
5. **Performance Monitoring**: Track accuracy over time

### Automated Retraining
```bash
# Monthly retraining with new data
cd machinelearning
python train_ai_model.py --full-pipeline --data-dir monthly_data
```

## 📈 Future Enhancements

### Planned Features
1. **Multi-language Support**: Analyze documents in Filipino/Tagalog
2. **Advanced ML Models**: BERT-based text classification
3. **Batch Processing**: Analyze multiple documents simultaneously
4. **Export Reports**: Generate PDF analysis reports
5. **Integration APIs**: Connect to external GI databases

### Model Improvements
1. **Training Data**: Collect labeled GI documents
2. **Feature Engineering**: Add n-grams and semantic features
3. **Ensemble Methods**: Combine multiple classifiers
4. **Active Learning**: Improve model with user feedback

## 📁 Project Structure

```
Beanthentic/
├── machinelearning/           # AI and ML components
│   ├── ai_engine.py          # Core AI analysis engine
│   ├── train_ai_model.py     # ML training pipeline
│   ├── gi_model.joblib       # Trained Random Forest model
│   ├── training_results.json # Training metrics
│   └── feature_importance.csv # Feature rankings
├── models.py                 # Database models
├── web.py                    # Flask application and API routes
├── dashboard.html            # Main dashboard with IPOPHL module
├── requirements.txt          # Python dependencies
├── uploads/                  # File storage for uploaded documents
├── css/
│   └── ipophl-analyzer.css   # AI analysis panel styles
├── js/
│   └── ipophl-analyzer.js    # Frontend JavaScript integration
└── docs/
    └── IPOPHL_AI_COMPLETE_GUIDE.md # This comprehensive guide
```

## 🎯 Best Practices

### Data Quality
- ✅ Clean, complete document texts
- ✅ Accurate labeling by domain experts
- ✅ Balanced class distribution
- ✅ Sufficient sample size (100+ documents)

### Model Training
- ✅ Use cross-validation for robust evaluation
- ✅ Hyperparameter tuning for optimal performance
- ✅ Feature importance analysis for insights
- ✅ Regular model retraining with new data

### Production Deployment
- ✅ Monitor model performance continuously
- ✅ Maintain fallback to rule-based system
- ✅ Log predictions for analysis
- ✅ User feedback collection for improvement

## 🚀 Quick Start

1. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

2. **Start Application**:
   ```bash
   python web.py
   ```

3. **Access Dashboard**:
   - Navigate to http://localhost:5001
   - Click "IPOPHL" in sidebar
   - Upload documents for AI analysis

4. **Train AI Model** (Optional):
   ```bash
   cd machinelearning
   python train_ai_model.py --full-pipeline
   ```

---

**Version**: 1.0.0  
**Last Updated**: 2025-04-28  
**Compatible**: Python 3.10+, Flask 3.0+

## 📞 Support

For training assistance:
1. Check logs in `train_ai_model.py` output
2. Review `uploads/training_results.json`
3. Validate dataset format and quality
4. Test with sample data first

**Ready to use your AI-powered IPOPHL system?**
```bash
python web.py
```
