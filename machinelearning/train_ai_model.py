#!/usr/bin/env python3
"""
Ensemble AI Training Pipeline for IPOPHL GI Document Analysis

Trains a soft-voting ensemble (bagging + boosting) for document MoP advisory
scoring. See ``ensemble_learning.py`` for the theory notes.

Usage:
    python train_ai_model.py --train-documents
    python train_ai_model.py --full-pipeline
    python train_ai_model.py --prepare-data
    python train_ai_model.py --evaluate
"""

import argparse
import json
import logging
import os
import warnings
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple

import joblib
import numpy as np
import pandas as pd
from sklearn.exceptions import InconsistentVersionWarning

# ML imports
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import GridSearchCV, cross_val_score, train_test_split

# Local imports
from ai_engine import GIAnalyzer
from ensemble_learning import (
    ENSEMBLE_DESCRIPTION,
    ENSEMBLE_METHOD,
    build_gi_ensemble,
    describe_ensemble,
    ensemble_feature_importances,
    ensemble_param_grid,
)

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# GridSearchCV n_jobs=-1 can crash on Windows (multiprocessing + scipy import races).
_GRID_N_JOBS = 1 if os.name == "nt" else -1

class GIDocumentTrainer:
    """Training pipeline for GI document ensemble analysis."""

    def __init__(self, data_dir: str = "training_data", models_dir: str = None):
        self.data_dir = Path(data_dir)
        # Default models_dir to the directory where the script is located
        if models_dir is None:
            self.models_dir = Path(__file__).parent
        else:
            self.models_dir = Path(models_dir)
            
        self.data_dir.mkdir(exist_ok=True)
        self.models_dir.mkdir(exist_ok=True)

        # Initialize analyzer for feature extraction (no nested auto-train during training)
        self.analyzer = GIAnalyzer(str(self.models_dir), auto_train=False)

        # Training data paths
        self.raw_data_path = self.data_dir / "gi_documents_raw.json"
        self.processed_data_path = self.data_dir / "gi_documents_processed.csv"
        self.features_path = self.data_dir / "features_matrix.npy"
        self.labels_path = self.data_dir / "labels.npy"

    def create_sample_dataset(self) -> List[Dict]:
        """Create a sample dataset for demonstration"""
        logger.info("Creating sample dataset...")

        sample_documents = [
            # Ready documents (high GI compliance)
            {
                "text": """
                LIPA CITY COFFEE GI REGISTRATION DOCUMENT

                Geographical Origin: Lipa City, Batangas, Philippines
                Altitude: 400-600 meters above sea level
                Soil Composition: Volcanic loam, rich in organic matter
                Climate: Tropical monsoon climate, distinct wet and dry seasons

                Traditional Cultivation Methods:
                - Shade-grown coffee trees
                - Hand-picking of ripe cherries
                - Natural processing methods

                Quality Characteristics:
                - Distinctive aroma and flavor profile
                - Medium to full body with chocolate notes
                - Low acidity, smooth finish

                Certification: Department of Agriculture Regional Field Office
                Notary Public: Batangas Province

                This product meets the specifications for Lipa Barako coffee
                geographical indication registration.
                """,
                "label": "Ready",
                "score": 85,
                "source": "sample"
            },
            {
                "text": """
                MANUAL OF SPECIFICATIONS - LIPA BARAKO COFFEE

                1. Geographical Area
                The coffee must be grown exclusively in Lipa City, Batangas
                within the specified coordinates and altitude ranges.

                2. Soil Requirements
                Volcanic soil with pH 6.0-6.5, rich in organic matter
                Well-drained terrain, moderate slope

                3. Climate Conditions
                Temperature range: 18-24°C
                Rainfall: 2000-2500mm annually
                Distinct dry season for proper harvesting

                4. Cultivation Standards
                Traditional farming practices preserved
                No chemical pesticides during flowering
                Harvest period: October to January

                5. Quality Standards
                Moisture content: 11-12%
                Bean size: 17-19 screen
                Cup quality: Distinct Barako flavor profile

                Certified by: Bureau of Plant Industry
                Notarized: Republic of the Philippines
                """,
                "label": "Ready",
                "score": 92,
                "source": "sample"
            },
            # Not Ready documents (missing key elements)
            {
                "text": """
                Coffee Farming Report

                We have been growing coffee for many years in our farm.
                The coffee plants are well maintained and produce good beans.
                We use traditional methods passed down through generations.

                Our coffee has a good taste that customers enjoy.
                We harvest the beans when they are ripe and process them carefully.

                The farm is located in a good area with proper climate conditions.
                We follow quality standards in our production process.
                """,
                "label": "Not Ready",
                "score": 25,
                "source": "sample"
            },
            {
                "text": """
                Agricultural Product Information

                Product: Coffee Beans
                Origin: Philippines
                Variety: Arabica and Robusta mix

                Production Method:
                - Sustainable farming practices
                - Organic certification pending
                - Quality control measures in place

                Market Information:
                - Premium quality beans
                - Sold to local and international markets
                - Good customer feedback

                We are seeking certification for our product quality
                and traditional farming methods.
                """,
                "label": "Not Ready",
                "score": 30,
                "source": "sample"
            },
            {
                "text": """
                AUTHORIZATION LETTER

                Date: February 27, 2026
                To: HR Team

                I, Arlyn Rubia, hereby authorize my sister Ma. Crestina Rubia
                to process and claim my retirement pay on my behalf.

                This authorization is given for administrative purposes.
                Signed: Arlyn Rubia
                """,
                "label": "Not Ready",
                "score": 35,
                "source": "sample"
            },
            {
                "text": """
                LIPA BARAKO PRODUCERS ORGANIZATION

                Applicant Entity: Lipa Barako Coffee Growers Association
                Legal Standing: Duly registered cooperative with SEC

                Membership List: Attached roster of 120 producer-members
                Stakeholder Consultations held March 2025 with meeting minutes

                The organization represents producers in Lipa City, Batangas
                for Geographical Indication registration of Lipa Barako coffee.
                """,
                "label": "Ready",
                "score": 78,
                "source": "sample"
            },
            # Borderline cases
            {
                "text": """
                Lipa Coffee Association Documentation

                Location: Lipa area, Batangas region
                Altitude: High elevation farming
                Soil: Rich volcanic soil composition

                Traditional Processing:
                - Hand sorting of beans
                - Natural drying methods
                - Quality inspection procedures

                Product Features:
                - Distinctive flavor characteristics
                - Traditional cultivation preserved
                - Geographic origin verification

                Requirements met:
                - Quality standards documentation
                - Traditional methods maintained
                - Geographic area specified

                Missing elements:
                - Official certification
                - Notary documentation
                - Complete specifications manual
                """,
                "label": "Not Ready",
                "score": 65,
                "source": "sample"
            }
        ]

        # Save sample dataset
        with open(self.raw_data_path, 'w', encoding='utf-8') as f:
            json.dump(sample_documents, f, indent=2, ensure_ascii=False)

        logger.info("Created sample dataset with %s documents", len(sample_documents))
        return sample_documents

    def load_dataset(self, create_sample_if_missing: bool = True) -> List[Dict]:
        """Load training dataset from file."""
        if not self.raw_data_path.exists():
            if create_sample_if_missing:
                return self.create_sample_dataset()
            raise FileNotFoundError(f"Dataset not found: {self.raw_data_path}")

        with open(self.raw_data_path, 'r', encoding='utf-8') as f:
            dataset = json.load(f)

        logger.info("Loaded dataset with %s documents", len(dataset))
        return dataset

    def extract_features_from_dataset(self, dataset: List[Dict]) -> Tuple[np.ndarray, np.ndarray]:
        """Extract features and labels from dataset"""
        logger.info("Extracting features from dataset...")

        features = []
        labels = []

        for doc in dataset:
            text = doc['text']
            label = 1 if doc['label'] == 'Ready' else 0

            # Extract features using the same method as the analyzer
            doc_features = self.analyzer._extract_features(text)
            features.append(doc_features)
            labels.append(label)

        feature_matrix = np.array(features)
        labels = np.array(labels)

        logger.info("Extracted features shape: %s", feature_matrix.shape)
        logger.info(
            "Labels distribution: %s (Not Ready: %s, Ready: %s)",
            np.bincount(labels),
            np.bincount(labels)[0],
            np.bincount(labels)[1],
        )

        return feature_matrix, labels

    def prepare_training_data(self) -> Tuple[np.ndarray, np.ndarray]:
        """Prepare training data and save to files."""
        logger.info("Preparing training data...")

        # Load dataset
        dataset = self.load_dataset()

        # Extract features
        feature_matrix, labels = self.extract_features_from_dataset(dataset)

        # Save processed data
        np.save(self.features_path, feature_matrix)
        np.save(self.labels_path, labels)

        # Create DataFrame for analysis
        feature_names = (['text_length', 'word_count'] +
                        self.analyzer.gi_checklist["mandatory_terms"] +
                        self.analyzer.gi_checklist["optional_terms"])

        df = pd.DataFrame(feature_matrix, columns=feature_names)
        df['label'] = labels
        df['readiness_score'] = [doc.get('score', 0) for doc in dataset]
        df.to_csv(self.processed_data_path, index=False)

        logger.info("Training data saved to %s", self.processed_data_path)
        return feature_matrix, labels

    def train_model(self, feature_matrix: np.ndarray = None, labels: np.ndarray = None) -> Dict:
        """Train soft-voting ensemble with hyperparameter tuning on the RF member."""
        logger.info("Training ensemble model (%s)...", ENSEMBLE_METHOD)

        # Load data if not provided
        if feature_matrix is None or labels is None:
            if self.features_path.exists() and self.labels_path.exists():
                feature_matrix = np.load(self.features_path)
                labels = np.load(self.labels_path)
            else:
                feature_matrix, labels = self.prepare_training_data()

        labels = np.asarray(labels)
        n_samples = len(feature_matrix)
        class_counts = np.bincount(labels.astype(int)) if labels.size else np.array([])
        if len(np.unique(labels)) < 2:
            raise ValueError("Need both Ready and Not Ready labels to train the document ensemble.")

        # Split data
        can_stratify = n_samples >= 10 and int(class_counts.min()) >= 2
        if can_stratify:
            feature_train, feature_test, label_train, label_test = train_test_split(
                feature_matrix, labels, test_size=0.2, random_state=42, stratify=labels
            )
        else:
            feature_train, feature_test, label_train, label_test = train_test_split(
                feature_matrix, labels, test_size=0.2, random_state=42
            )

        # Tiny MoP sets: bagging-only vote + direct fit (GB/GridSearch often see 1 class).
        use_boosting = n_samples >= 40 and int(class_counts.min()) >= 3
        ensemble = build_gi_ensemble(
            random_state=42,
            class_weight="balanced",
            include_boosting=use_boosting,
        )

        best_params: dict
        if n_samples < 40 or not use_boosting:
            logger.info(
                "Small/imbalanced document set (n=%s) — direct ensemble fit (boosting=%s)",
                n_samples,
                use_boosting,
            )
            ensemble.fit(feature_train, label_train)
            best_model = ensemble
            best_params = {
                "mode": "direct_fit",
                "include_boosting": use_boosting,
                "n_samples": int(n_samples),
            }
        else:
            n_folds = 5 if n_samples >= 25 else 3
            # Always use the compact grid — full grid is too slow on typical thesis hardware.
            compact = True
            grid_search = GridSearchCV(
                ensemble,
                ensemble_param_grid(compact=compact),
                cv=n_folds,
                scoring="accuracy",
                n_jobs=_GRID_N_JOBS,
                verbose=1,
                error_score=0.0,
            )
            grid_search.fit(feature_train, label_train)
            best_model = grid_search.best_estimator_
            best_params = grid_search.best_params_

        # Evaluate on test set
        predictions = best_model.predict(feature_test)
        accuracy = accuracy_score(label_test, predictions)

        cv_folds = min(5, int(class_counts.min()), n_samples) if n_samples >= 10 else 2
        cv_folds = max(2, cv_folds)
        try:
            cv_scores = cross_val_score(best_model, feature_matrix, labels, cv=cv_folds)
        except Exception as cv_exc:
            logger.warning("CV skipped: %s", cv_exc)
            cv_scores = np.array([accuracy])

        # Feature importance
        feature_names = (['text_length', 'word_count'] +
                        self.analyzer.gi_checklist["mandatory_terms"] +
                        self.analyzer.gi_checklist["optional_terms"])

        importances = ensemble_feature_importances(best_model, n_features=len(feature_names))
        feature_importance = pd.DataFrame({
            'feature': feature_names,
            'importance': importances
        }).sort_values('importance', ascending=False)

        # Training results
        results = {
            'model': best_model,
            'accuracy': accuracy,
            'cv_mean': float(cv_scores.mean()),
            'cv_std': float(cv_scores.std()),
            'best_params': best_params,
            'feature_importance': feature_importance,
            'classification_report': classification_report(
                label_test, predictions, output_dict=True, zero_division=0
            ),
            'confusion_matrix': confusion_matrix(label_test, predictions).tolist(),
            'ensemble': describe_ensemble(best_model),
            'ensemble_method': ENSEMBLE_METHOD,
            'ensemble_description': ENSEMBLE_DESCRIPTION,
        }

        logger.info("Training completed. Accuracy: %.3f ± %.3f", accuracy, cv_scores.std())
        logger.info("Best parameters: %s", best_params)
        logger.info("Ensemble: %s", ENSEMBLE_DESCRIPTION)

        return results

    def train_document_model(self) -> Dict:
        """Train ensemble on GI document text features (keyword + length)."""
        logger.info("Training document ensemble model...")
        feature_matrix, labels = self.prepare_training_data()
        results = self.train_model(feature_matrix, labels)
        doc_path = self.models_dir / "gi_document_model.joblib"
        joblib.dump(results["model"], doc_path)
        logger.info("Document model saved to %s", doc_path)
        results["document_model_path"] = str(doc_path)

        dataset = self.load_dataset(create_sample_if_missing=False)
        training_results = {
            "accuracy": results["accuracy"],
            "cv_mean": results["cv_mean"],
            "cv_std": results["cv_std"],
            "best_params": results["best_params"],
            "classification_report": results["classification_report"],
            "confusion_matrix": results["confusion_matrix"],
            "training_date": datetime.now().isoformat(),
            "model_type": "document_ensemble",
            "sample_count": len(dataset),
            "ready_count": sum(1 for d in dataset if d.get("label") == "Ready"),
            "not_ready_count": sum(1 for d in dataset if d.get("label") != "Ready"),
            "training_source": "ipophl_official_mop_dataset.csv",
            "analysis_method": "official_mop_ensemble_hybrid",
            "ensemble_method": results.get("ensemble_method", ENSEMBLE_METHOD),
            "ensemble_description": results.get(
                "ensemble_description", ENSEMBLE_DESCRIPTION
            ),
            "ensemble": results.get("ensemble") or describe_ensemble(results["model"]),
            "learning_theory": "ensemble_learning",
        }
        with open(self.models_dir / "document_training_results.json", "w", encoding="utf-8") as f:
            json.dump(training_results, f, indent=2)

        return results

    def save_model(self, results: Dict, *, model_name: str = "gi_document_model.joblib") -> None:
        """Save trained document model and results."""
        logger.info("Saving trained model...")

        # Save model
        model_path = self.models_dir / model_name
        joblib.dump(results['model'], model_path)

        # Save feature importance
        results['feature_importance'].to_csv(
            self.models_dir / "feature_importance.csv", index=False
        )

        # Save training results
        training_results = {
            'accuracy': results['accuracy'],
            'cv_mean': results['cv_mean'],
            'cv_std': results['cv_std'],
            'best_params': results['best_params'],
            'classification_report': results['classification_report'],
            'confusion_matrix': results['confusion_matrix'],
            'training_date': datetime.now().isoformat(),
            'feature_importance_top10': results['feature_importance'].head(10).to_dict('records'),
            'ensemble_method': results.get('ensemble_method', ENSEMBLE_METHOD),
            'ensemble_description': results.get('ensemble_description', ENSEMBLE_DESCRIPTION),
            'ensemble': results.get('ensemble') or describe_ensemble(results['model']),
            'learning_theory': 'ensemble_learning',
            'model_type': 'document_ensemble',
        }

        out_name = (
            "document_training_results.json"
            if model_name == "gi_document_model.joblib"
            else "training_results.json"
        )
        with open(self.models_dir / out_name, 'w', encoding='utf-8') as f:
            json.dump(training_results, f, indent=2)

        logger.info("Model saved to %s", model_path)

    def evaluate_model(self) -> Dict:
        """Evaluate trained document model performance."""
        logger.info("Evaluating model performance...")

        model_path = self.models_dir / "gi_document_model.joblib"
        if not model_path.exists():
            raise FileNotFoundError(
                "Document model not found. Train with: python train_ai_model.py --train-documents"
            )

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            model = joblib.load(model_path)
        if any(issubclass(w.category, InconsistentVersionWarning) for w in caught):
            logger.warning(
                "Detected sklearn version mismatch for %s; retraining is recommended before evaluation.",
                model_path,
            )

        # Load test data
        if self.features_path.exists() and self.labels_path.exists():
            feature_matrix = np.load(self.features_path)
            labels = np.load(self.labels_path)
        else:
            feature_matrix, labels = self.prepare_training_data()

        # Split for evaluation
        if len(feature_matrix) < 10:
            feature_train, feature_test, label_train, label_test = train_test_split(
                feature_matrix, labels, test_size=0.2, random_state=42
            )
        else:
            feature_train, feature_test, label_train, label_test = train_test_split(
                feature_matrix, labels, test_size=0.2, random_state=42, stratify=labels
            )

        # Predictions
        predictions = model.predict(feature_test)

        # Metrics
        accuracy = accuracy_score(label_test, predictions)

        feature_names = (
            ['text_length', 'word_count']
            + self.analyzer.gi_checklist["mandatory_terms"]
            + self.analyzer.gi_checklist["optional_terms"]
        )
        importances = ensemble_feature_importances(model, n_features=len(feature_names))

        # Detailed report
        evaluation = {
            'accuracy': accuracy,
            'classification_report': classification_report(label_test, predictions, output_dict=True),
            'confusion_matrix': confusion_matrix(label_test, predictions).tolist(),
            'ensemble': describe_ensemble(model),
            'feature_importance': pd.DataFrame({
                'feature': feature_names,
                'importance': importances
            }).sort_values('importance', ascending=False).head(10).to_dict('records')
        }

        logger.info("Evaluation completed. Accuracy: %.3f", accuracy)
        return evaluation

    def create_real_dataset_template(self) -> str:
        """Create a template for real dataset collection."""
        template_path = self.data_dir / "dataset_template.json"

        template = [
            {
                "text": "Your document text here...",
                "label": "Ready",  # or "Not Ready"
                "score": 85,  # 0-100 readiness score
                "source": "manual",  # or "scraped", "generated"
                "notes": "Optional notes about this document"
            }
        ]

        with open(template_path, 'w', encoding='utf-8') as f:
            json.dump(template, f, indent=2)

        logger.info("Dataset template created at %s", template_path)
        return str(template_path)

def main():
    parser = argparse.ArgumentParser(
        description='Train ensemble (bagging + boosting soft vote) for GI readiness analysis'
    )
    parser.add_argument('--prepare-data', action='store_true', help='Prepare training data')
    parser.add_argument('--train', action='store_true', help='Train the model from JSON')
    parser.add_argument('--train-documents', action='store_true', help='Train document model only from JSON samples')
    parser.add_argument('--evaluate', action='store_true', help='Evaluate the model')
    parser.add_argument('--full-pipeline', action='store_true', help='Train GI document ensemble (default app pipeline)')
    parser.add_argument('--create-template', action='store_true', help='Create dataset template')
    parser.add_argument('--data-dir', default='training_data', help='Training data directory')

    args = parser.parse_args()

    trainer = GIDocumentTrainer(args.data_dir)

    if args.create_template:
        trainer.create_real_dataset_template()
        return

    if args.full_pipeline or args.train_documents:
        logger.info("Running document training pipeline...")
        doc_results = trainer.train_document_model()
        print("\nDocument training completed successfully!")
        print(f"Document model accuracy: {doc_results['accuracy']:.3f}")
        print(f"Document model: {trainer.models_dir / 'gi_document_model.joblib'}")
        return

    if args.prepare_data:
        trainer.prepare_training_data()

    if args.train:
        results = trainer.train_model()
        trainer.save_model(results, model_name="gi_document_model.joblib")

    if args.evaluate:
        evaluation = trainer.evaluate_model()
        print("Evaluation Results:")
        print(f"Accuracy: {evaluation['accuracy']:.3f}")
        print("Top Features:")
        for feat in evaluation['feature_importance']:
            print(f"  {feat['feature']}: {feat['importance']:.3f}")

if __name__ == "__main__":
    main()
