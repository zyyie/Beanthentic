from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
import json

db = SQLAlchemy()

# Main farmer table (shared identity)
class Farmer(db.Model):
    __tablename__ = 'farmers'
    
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    no = db.Column(db.Integer)
    last_name = db.Column(db.String(100))
    first_name = db.Column(db.String(100))
    address_barangay = db.Column(db.String(150))
    birthday = db.Column(db.Date)
    remarks = db.Column(db.Text)
    
    # Relationships
    affiliation = db.relationship('Affiliation', backref='farmer', uselist=False, cascade='all, delete-orphan')
    farm_info = db.relationship('FarmInfo', backref='farmer', uselist=False, cascade='all, delete-orphan')
    tree_counts = db.relationship('TreeCounts', backref='farmer', uselist=False, cascade='all, delete-orphan')
    production = db.relationship('Production', backref='farmer', uselist=False, cascade='all, delete-orphan')
    
    @property
    def name(self):
        """Combine last_name and first_name"""
        if self.last_name and self.first_name:
            return f"{self.last_name} {self.first_name}"
        return self.last_name or self.first_name or ""
    
    def __repr__(self):
        return f"Farmer('{self.name}', '{self.address_barangay}')"

# Affiliation table
class Affiliation(db.Model):
    __tablename__ = 'affiliations'
    
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.Integer, db.ForeignKey('farmers.id', ondelete='CASCADE'))
    fa_officer_member = db.Column(db.String(100))
    rsbsa_registered = db.Column(db.Enum('YES', 'NO'))
    ncfrs = db.Column(db.String(100))
    
    def __repr__(self):
        return f"Affiliation('{self.fa_officer_member}', '{self.rsbsa_registered}')"

# Farm Info table
class FarmInfo(db.Model):
    __tablename__ = 'farm_info'
    
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.Integer, db.ForeignKey('farmers.id', ondelete='CASCADE'))
    is_landowner = db.Column(db.Boolean, default=False)
    is_cloa_holder = db.Column(db.Boolean, default=False)
    is_leaseholder = db.Column(db.Boolean, default=False)
    is_seasonal_farm_worker = db.Column(db.Boolean, default=False)
    is_others = db.Column(db.Boolean, default=False)
    total_area_planted_ha = db.Column(db.Numeric(10, 4))
    
    def __repr__(self):
        return f"FarmInfo('{self.total_area_planted_ha} HA')"

# Tree Counts table
class TreeCounts(db.Model):
    __tablename__ = 'tree_counts'
    
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.Integer, db.ForeignKey('farmers.id', ondelete='CASCADE'))
    liberica_bearing = db.Column(db.Integer, default=0)
    liberica_non_bearing = db.Column(db.Integer, default=0)
    excelsa_bearing = db.Column(db.Integer, default=0)
    excelsa_non_bearing = db.Column(db.Integer, default=0)
    robusta_bearing = db.Column(db.Integer, default=0)
    robusta_non_bearing = db.Column(db.Integer, default=0)
    
    # Computed columns (handled in Python since MySQL generated columns need special handling)
    @property
    def total_bearing(self):
        return self.liberica_bearing + self.excelsa_bearing + self.robusta_bearing
    
    @property
    def total_non_bearing(self):
        return self.liberica_non_bearing + self.excelsa_non_bearing + self.robusta_non_bearing
    
    @property
    def total_trees(self):
        return (self.liberica_bearing + self.liberica_non_bearing + 
                self.excelsa_bearing + self.excelsa_non_bearing + 
                self.robusta_bearing + self.robusta_non_bearing)
    
    def __repr__(self):
        return f"TreeCounts(Total: {self.total_trees})"

# Production table
class Production(db.Model):
    __tablename__ = 'production'
    
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.Integer, db.ForeignKey('farmers.id', ondelete='CASCADE'))
    liberica_kg = db.Column(db.Numeric(10, 2), default=0)
    excelsa_kg = db.Column(db.Numeric(10, 2), default=0)
    robusta_kg = db.Column(db.Numeric(10, 2), default=0)
    
    @property
    def total_production(self):
        return float(self.liberica_kg or 0) + float(self.excelsa_kg or 0) + float(self.robusta_kg or 0)
    
    def __repr__(self):
        return f"Production(Total: {self.total_production} kg)"

# Admin user table (keeping existing)
class AdminUser(db.Model):
    __tablename__ = "admin_user"

    email = db.Column(db.String(255), primary_key=True)
    full_name = db.Column(db.String(255), nullable=False)
    password_hash = db.Column(db.String(512), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"AdminUser('{self.email}')"

# Activity log table (keeping existing)
class ActivityLogEntry(db.Model):
    __tablename__ = "activity_log_entry"

    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, nullable=False, index=True)
    user_email = db.Column(db.String(255), nullable=False, index=True)
    action = db.Column(db.String(80), nullable=False, index=True)
    details = db.Column(db.Text, default="")
    ip_address = db.Column(db.String(64), default="")

    def __repr__(self):
        return f"ActivityLogEntry('{self.action}', '{self.user_email}')"

# Document analysis table for IPOPHL AI processing
class DocumentAnalysis(db.Model):
    __tablename__ = "document_analysis"

    id = db.Column(db.Integer, primary_key=True)
    file_uuid = db.Column(db.String(36), unique=True, nullable=False, index=True)
    original_filename = db.Column(db.String(255), nullable=False)
    file_path = db.Column(db.String(500), nullable=False)
    file_type = db.Column(db.String(50), nullable=False)
    file_size = db.Column(db.Integer, nullable=False)
    
    # AI Analysis results
    ai_score = db.Column(db.Integer, default=0)  # 0-100
    ai_status = db.Column(db.String(20), default="Not Ready")
    detected_features = db.Column(db.Text)  # JSON string
    missing_requirements = db.Column(db.Text)  # JSON string
    analysis_method = db.Column(db.String(50), default="rule_based")
    text_length = db.Column(db.Integer, default=0)
    
    # Metadata
    upload_timestamp = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    analysis_timestamp = db.Column(db.DateTime)
    ipophl_phase = db.Column(db.String(50))  # Which phase this document belongs to
    task_id = db.Column(db.String(100))  # Which specific task
    
    def __repr__(self):
        return f"DocumentAnalysis('{self.original_filename}', score={self.ai_score})"
    
    @property
    def detected_features_list(self):
        if self.detected_features:
            try:
                return json.loads(self.detected_features)
            except:
                return []
        return []
    
    @property
    def missing_requirements_list(self):
        if self.missing_requirements:
            try:
                return json.loads(self.missing_requirements)
            except:
                return []
        return []
    
    def set_detected_features(self, features_list):
        self.detected_features = json.dumps(features_list)
    
    def set_missing_requirements(self, requirements_list):
        self.missing_requirements = json.dumps(requirements_list)
