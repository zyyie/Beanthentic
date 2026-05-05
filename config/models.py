"""
Database models for Beanthentic application.

Defines SQLAlchemy models for farmers, affiliations, farm info,
tree counts, production, admin users, activity logs, document analysis,
and coffee transactions.
"""

from datetime import datetime

import json
from flask_sqlalchemy import SQLAlchemy

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
    """Affiliation information for farmers."""
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
    """Farm information for farmers."""
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
    """Tree counts for coffee varieties."""
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
        """Calculate total bearing trees."""
        return self.liberica_bearing + self.excelsa_bearing + self.robusta_bearing

    @property
    def total_non_bearing(self):
        """Calculate total non-bearing trees."""
        return self.liberica_non_bearing + self.excelsa_non_bearing + self.robusta_non_bearing

    @property
    def total_trees(self):
        """Calculate total trees."""
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
        """Calculate total production in kg."""
        return float(self.liberica_kg or 0) + float(self.excelsa_kg or 0) + float(self.robusta_kg or 0)

    def __repr__(self):
        return f"Production(Total: {self.total_production} kg)"

# Admin user table (keeping existing)
class AdminUser(db.Model):
    """Admin user accounts."""
    __tablename__ = "admin_user"

    phone_number = db.Column(db.String(255), primary_key=True)
    full_name = db.Column(db.String(255), nullable=False)
    password_hash = db.Column(db.String(512), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"AdminUser('{self.phone_number}')"

# Activity log table (keeping existing)
class ActivityLogEntry(db.Model):
    """Activity log entries for admin actions."""
    __tablename__ = "activity_log_entry"

    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime, nullable=False, index=True)
    user_phone = db.Column(db.String(255), nullable=False, index=True)
    action = db.Column(db.String(80), nullable=False, index=True)
    details = db.Column(db.Text, default="")
    ip_address = db.Column(db.String(64), default="")

    def __repr__(self):
        return f"ActivityLogEntry('{self.action}', '{self.user_phone}')"

# Document analysis table for IPOPHL AI processing
class DocumentAnalysis(db.Model):
    """Document analysis model for IPOPHL AI processing."""

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
        """Parse detected features from JSON string."""
        if self.detected_features:
            try:
                return json.loads(self.detected_features)
            except (json.JSONDecodeError, TypeError):
                return []
        return []

    @property
    def missing_requirements_list(self):
        """Parse missing requirements from JSON string."""
        if self.missing_requirements:
            try:
                return json.loads(self.missing_requirements)
            except (json.JSONDecodeError, TypeError):
                return []
        return []

    def set_detected_features(self, features_list):
        """Set detected features from list."""
        self.detected_features = json.dumps(features_list)

    def set_missing_requirements(self, requirements_list):
        """Set missing requirements from list."""
        self.missing_requirements = json.dumps(requirements_list)


class FarmerCoffeeTransaction(db.Model):
    """Ledger of coffee bean kg changes per farmer (sales to buyers, returns, corrections)."""

    __tablename__ = "farmer_coffee_transaction"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.Integer, db.ForeignKey("farmers.id", ondelete="CASCADE"), nullable=False, index=True)
    recorded_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)
    # liberica | excelsa | robusta — one variety per row
    variety = db.Column(db.String(20), nullable=False)
    # Positive = farmer gains kg (e.g. correction, return). Negative = kg left stock (e.g. sale to buyer).
    delta_kg = db.Column(db.Numeric(14, 4), nullable=False)
    buyer_name = db.Column(db.String(200), default="")
    notes = db.Column(db.Text, default="")
    recorded_by_phone = db.Column(db.String(32), default="")

    farmer = db.relationship(
        "Farmer",
        backref=db.backref(
            "coffee_transactions",
            lazy="dynamic",
            order_by="FarmerCoffeeTransaction.recorded_at",
        ),
    )

    def __repr__(self):
        return f"FarmerCoffeeTransaction(farmer_id={self.farmer_id}, {self.delta_kg} kg {self.variety})"


class Message(db.Model):
    """Internal messaging between admins and farmer-related communications."""
    __tablename__ = "messages"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    sender_phone = db.Column(db.String(32), nullable=False, index=True)
    sender_name = db.Column(db.String(255), nullable=False)
    recipient_phone = db.Column(db.String(32), default="", index=True)
    recipient_name = db.Column(db.String(255), default="")
    subject = db.Column(db.String(300), nullable=False)
    body = db.Column(db.Text, nullable=False)
    category = db.Column(db.String(30), default="general")  # general | farmer-update | announcement | reminder
    farmer_id = db.Column(db.Integer, db.ForeignKey("farmers.id", ondelete="SET NULL"), nullable=True)
    is_read = db.Column(db.Boolean, default=False, index=True)
    is_starred = db.Column(db.Boolean, default=False)
    is_archived = db.Column(db.Boolean, default=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)
    read_at = db.Column(db.DateTime, nullable=True)

    farmer = db.relationship(
        "Farmer",
        backref=db.backref("messages", lazy="dynamic"),
    )

    def __repr__(self):
        return f"Message(id={self.id}, subject='{self.subject[:30]}', from={self.sender_phone})"

    def to_dict(self):
        """Serialize message to dict for JSON responses."""
        return {
            "id": self.id,
            "sender_phone": self.sender_phone,
            "sender_name": self.sender_name,
            "recipient_phone": self.recipient_phone,
            "recipient_name": self.recipient_name,
            "subject": self.subject,
            "body": self.body,
            "category": self.category,
            "farmer_id": self.farmer_id,
            "is_read": self.is_read,
            "is_starred": self.is_starred,
            "is_archived": self.is_archived,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "read_at": self.read_at.isoformat() if self.read_at else None,
        }
