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
    profile_photo = db.Column(db.String(255))
    account_id = db.Column(db.Integer, db.ForeignKey('admin_user.id', ondelete='SET NULL'))
    client_id = db.Column(db.Integer, db.ForeignKey('clients.id', ondelete='SET NULL'))
    user_id = db.Column(db.BigInteger)
    status = db.Column(db.String(20), default='pending')
    is_suspended = db.Column(db.Boolean, default=False)
    suspended_until = db.Column(db.DateTime)
    suspension_reason = db.Column(db.String(500))
    warning_count = db.Column(db.Integer, default=0)
    last_warning_at = db.Column(db.DateTime)
    last_warning_reason = db.Column(db.String(500))
    last_warning_ack_at = db.Column(db.DateTime)

    # Relationships
    affiliation = db.relationship('Affiliation', backref='farmer', uselist=False, cascade='all, delete-orphan')
    farm_info = db.relationship('FarmInfo', backref='farmer', uselist=False, cascade='all, delete-orphan')
    tree_counts = db.relationship('TreeCounts', backref='farmer', uselist=False, cascade='all, delete-orphan')
    production = db.relationship('Production', backref='farmer', uselist=False, cascade='all, delete-orphan')

    @property
    def fa_officer_member(self):
        return self.affiliation.fa_officer_member if self.affiliation else ""

    @property
    def rsbsa_registered(self):
        return self.affiliation.rsbsa_registered if self.affiliation else ""

    @property
    def rsbsa_number(self):
        return self.affiliation.rsbsa_number if self.affiliation else ""

    @property
    def ncfrs(self):
        return self.affiliation.ncfrs if self.affiliation else ""

    @property
    def status_ownership(self):
        if not self.farm_info:
            return ""
        statuses = []
        if self.farm_info.is_landowner: statuses.append("Owner-Operator")
        if self.farm_info.is_leaseholder: statuses.append("Leaseholder")
        if self.farm_info.is_cloa_holder: statuses.append("CLOA")
        if self.farm_info.is_seasonal_farm_worker: statuses.append("Seasonal")
        if self.farm_info.is_others: statuses.append("Others")
        return ", ".join(statuses)

    @property
    def total_area_planted_ha(self):
        return float(self.farm_info.total_area_planted_ha or 0) if self.farm_info else 0

    @property
    def liberica_bearing(self):
        return self.tree_counts.liberica_bearing if self.tree_counts else 0

    @property
    def liberica_non_bearing(self):
        return self.tree_counts.liberica_non_bearing if self.tree_counts else 0

    @property
    def excelsa_bearing(self):
        return self.tree_counts.excelsa_bearing if self.tree_counts else 0

    @property
    def excelsa_non_bearing(self):
        return self.tree_counts.excelsa_non_bearing if self.tree_counts else 0

    @property
    def robusta_bearing(self):
        return self.tree_counts.robusta_bearing if self.tree_counts else 0

    @property
    def robusta_non_bearing(self):
        return self.tree_counts.robusta_non_bearing if self.tree_counts else 0

    @property
    def total_bearing(self):
        return self.tree_counts.total_bearing if self.tree_counts else 0

    @property
    def total_non_bearing(self):
        return self.tree_counts.total_non_bearing if self.tree_counts else 0

    @property
    def total_trees(self):
        return self.tree_counts.total_trees if self.tree_counts else 0

    @property
    def liberica_production(self):
        return float(self.production.liberica_kg or 0) if self.production else 0

    @property
    def excelsa_production(self):
        return float(self.production.excelsa_kg or 0) if self.production else 0

    @property
    def robusta_production(self):
        return float(self.production.robusta_kg or 0) if self.production else 0

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
    __tablename__ = 'affiliation_information'

    affiliation_info_id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.BigInteger, db.ForeignKey('farmers.id', ondelete='CASCADE'))
    federation_assoc = db.Column(db.String(255))
    coop_name = db.Column(db.String(255))
    rsbsa_registered = db.Column(db.String(20))
    rsbsa_number = db.Column(db.String(100))
    rsbsa_status = db.Column(db.String(50))
    ncfrs = db.Column(db.String(100))
    created_at = db.Column(db.DateTime)
    updated_at = db.Column(db.DateTime)

    @property
    def fa_officer_member(self):
        return self.federation_assoc or ""

    def __repr__(self):
        return f"Affiliation('{self.fa_officer_member}', '{self.rsbsa_registered}')"

# Farm Info table
class FarmInfo(db.Model):
    """Farm information for farmers."""
    __tablename__ = 'farm_information'

    farm_info_id = db.Column(db.BigInteger, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.BigInteger, db.ForeignKey('farmers.id', ondelete='CASCADE'))
    farm_name = db.Column(db.String(255))
    is_landowner = db.Column(db.Boolean, default=False)
    is_cloa_holder = db.Column(db.Boolean, default=False)
    is_leaseholder = db.Column(db.Boolean, default=False)
    is_seasonal_farm_worker = db.Column(db.Boolean, default=False)
    is_others = db.Column(db.Boolean, default=False)
    ownership_status = db.Column(db.String(40))
    total_area_planted_ha = db.Column(db.Numeric(10, 4))
    barangay = db.Column(db.String(150))
    created_at = db.Column(db.DateTime)
    updated_at = db.Column(db.DateTime)

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
    beans_remaining = db.Column(db.Numeric(10, 2), default=0)

    @property
    def total_production(self):
        """Calculate total production in kg."""
        return float(self.liberica_kg or 0) + float(self.excelsa_kg or 0) + float(self.robusta_kg or 0)

    def __repr__(self):
        return f"Production(Total: {self.total_production} kg)"

# Notification table
class Notification(db.Model):
    """General notifications for users."""
    __tablename__ = 'notifications'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    account_id = db.Column(db.Integer, db.ForeignKey('admin_user.id', ondelete='CASCADE'))
    message = db.Column(db.Text, nullable=False)
    type = db.Column(db.String(50))  # e.g., 'info', 'warning', 'alert'
    is_read = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

# Social table
class Social(db.Model):
    """Social media links for accounts."""
    __tablename__ = 'social'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    account_id = db.Column(db.Integer, db.ForeignKey('admin_user.id', ondelete='CASCADE'))
    url = db.Column(db.String(500), nullable=False)

# Client table
class Client(db.Model):
    """Client information."""
    __tablename__ = 'clients'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    report = db.Column(db.Text)

# Maps table
class Map(db.Model):
    """Geographic information for farmers."""
    __tablename__ = 'maps'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.Integer, db.ForeignKey('farmers.id', ondelete='CASCADE'))
    coffee_variety = db.Column(db.String(100))
    barangay_landmarks = db.Column(db.Text)

# GI Farmers Contribution table
class GIFarmersContribution(db.Model):
    """Geographic Indication contribution data."""
    __tablename__ = 'gi_farmers_contribution'

    farmer_id = db.Column(db.Integer, db.ForeignKey('farmers.id', ondelete='CASCADE'), primary_key=True)
    ipophil_id = db.Column(db.Integer, db.ForeignKey('document_analysis.id', ondelete='CASCADE'))
    gi_document = db.Column(db.String(500))
    images = db.Column(db.Text)  # JSON string of image paths

# Admin Notification table
class AdminNotification(db.Model):
    """Notifications specifically for admins regarding farmer registrations."""
    __tablename__ = 'admin_notifications'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    farmer_id = db.Column(db.Integer, db.ForeignKey('farmers.id', ondelete='CASCADE'))
    admin_id = db.Column(db.Integer, db.ForeignKey('admin_user.id', ondelete='CASCADE'))
    approve_decline_registration = db.Column(db.String(20))  # 'PENDING', 'APPROVED', 'DECLINED'

# Updates table
class Update(db.Model):
    """Platform updates or posts."""
    __tablename__ = 'updates'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    admin_id = db.Column(db.Integer, db.ForeignKey('admin_user.id', ondelete='CASCADE'))
    image_url = db.Column(db.String(500))
    content = db.Column(db.Text)
    title = db.Column(db.String(255))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    likes_count = db.Column(db.Integer, default=0)

# Admin user table (keeping existing)
class AdminUser(db.Model):
    """Admin user accounts."""
    __tablename__ = "admin_user"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    phone_number = db.Column(db.String(255), unique=True, nullable=False)
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
    shap_analysis = db.Column(db.Text)  # In-depth SHAP analysis in paragraph form

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
    payment_amount = db.Column(db.Numeric(14, 2))
    payment_method = db.Column(db.String(50))
    reference_no = db.Column(db.String(100))
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


class MisconductReport(db.Model):
    """Customer reports about farmer misconduct (Client Report module)."""

    __tablename__ = "misconduct_report"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)

    reporter_name = db.Column(db.String(255), nullable=False)
    reporter_contact = db.Column(db.String(255), default="")

    farmer_id = db.Column(db.Integer, db.ForeignKey("farmers.id", ondelete="SET NULL"), nullable=True, index=True)
    # Snapshot fields so the report still makes sense if the farmer record changes.
    farmer_no = db.Column(db.Integer, nullable=True)
    farmer_name = db.Column(db.String(255), default="")

    allegation = db.Column(db.Text, nullable=False)
    status = db.Column(db.String(30), default="open", index=True)  # open | under_review | resolved | dismissed

    farmer = db.relationship("Farmer", backref=db.backref("misconduct_reports", lazy="dynamic"))

    def to_dict(self):
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "reporter_name": self.reporter_name,
            "reporter_contact": self.reporter_contact,
            "farmer_id": self.farmer_id,
            "farmer_no": self.farmer_no,
            "farmer_name": self.farmer_name,
            "allegation": self.allegation,
            "status": self.status,
        }
