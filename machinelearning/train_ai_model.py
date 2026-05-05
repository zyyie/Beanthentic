#!/usr/bin/env python3
"""
Random Forest AI Training Pipeline for IPOPHL GI Document Analysis

This script provides a complete training pipeline for the Random Forest classifier
used in the IPOPHL GI document analysis system.

Usage:
    python train_ai_model.py --prepare-data
    python train_ai_model.py --train
    python train_ai_model.py --evaluate
    python train_ai_model.py --full-pipeline
"""

import argparse
import json
import logging

from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple

import joblib
import numpy as np
import pandas as pd

# ML imports
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import GridSearchCV, cross_val_score, train_test_split

# Local imports
from ai_engine import GIAnalyzer

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class GIDocumentTrainer:
    """Training pipeline for GI Document Analysis"""

    def __init__(self, data_dir: str = "training_data", models_dir: str = "../uploads"):
        self.data_dir = Path(data_dir)
        self.models_dir = Path(models_dir)
        self.data_dir.mkdir(exist_ok=True)
        self.models_dir.mkdir(exist_ok=True)

        # Initialize analyzer for feature extraction
        self.analyzer = GIAnalyzer(str(models_dir))

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
        """Train Random Forest model with hyperparameter tuning."""
        logger.info("Training Random Forest model...")

        # Load data if not provided
        if feature_matrix is None or labels is None:
            if self.features_path.exists() and self.labels_path.exists():
                feature_matrix = np.load(self.features_path)
                labels = np.load(self.labels_path)
            else:
                feature_matrix, labels = self.prepare_training_data()

        # Split data
        if len(feature_matrix) < 10:
            # For very small datasets, use simple split without stratification
            feature_train, feature_test, label_train, label_test = train_test_split(
                feature_matrix, labels, test_size=0.2, random_state=42
            )
        else:
            # For larger datasets, use stratified split
            feature_train, feature_test, label_train, label_test = train_test_split(
                feature_matrix, labels, test_size=0.2, random_state=42, stratify=labels
            )

        # Hyperparameter grid
        param_grid = {
            'n_estimators': [50, 100, 200],
            'max_depth': [10, 20, None],
            'min_samples_split': [2, 5, 10],
            'min_samples_leaf': [1, 2, 4],
            'max_features': ['sqrt', 'log2']
        }

        # Initialize and train model
        rf = RandomForestClassifier(random_state=42)

        # Grid search with cross-validation
        if len(feature_matrix) < 10:
            # For very small datasets, use simpler validation
            grid_search = GridSearchCV(
                rf, param_grid, cv=2, scoring='accuracy', n_jobs=-1, verbose=1
            )
        else:
            # For larger datasets, use standard 5-fold CV
            grid_search = GridSearchCV(
                rf, param_grid, cv=5, scoring='accuracy', n_jobs=-1, verbose=1
            )

        grid_search.fit(feature_train, label_train)

        # Best model
        best_model = grid_search.best_estimator_

        # Evaluate on test set
        predictions = best_model.predict(feature_test)
        accuracy = accuracy_score(label_test, predictions)

        # Cross-validation score
        if len(feature_matrix) >= 10:
            cv_scores = cross_val_score(best_model, feature_matrix, labels, cv=5)
        else:
            cv_scores = cross_val_score(best_model, feature_matrix, labels, cv=2)

        # Feature importance
        feature_names = (['text_length', 'word_count'] +
                        self.analyzer.gi_checklist["mandatory_terms"] +
                        self.analyzer.gi_checklist["optional_terms"])

        feature_importance = pd.DataFrame({
            'feature': feature_names,
            'importance': best_model.feature_importances_
        }).sort_values('importance', ascending=False)

        # Training results
        results = {
            'model': best_model,
            'accuracy': accuracy,
            'cv_mean': cv_scores.mean(),
            'cv_std': cv_scores.std(),
            'best_params': grid_search.best_params_,
            'feature_importance': feature_importance,
            'classification_report': classification_report(label_test, predictions, output_dict=True),
            'confusion_matrix': confusion_matrix(label_test, predictions).tolist()
        }

        logger.info("Training completed. Accuracy: %.3f ± %.3f", accuracy, cv_scores.std())
        logger.info("Best parameters: %s", grid_search.best_params_)

        return results

    def save_model(self, results: Dict) -> None:
        """Save trained model and results."""
        logger.info("Saving trained model...")

        # Save model
        model_path = self.models_dir / "gi_model.joblib"
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
            'feature_importance_top10': results['feature_importance'].head(10).to_dict('records')
        }

        with open(self.models_dir / "training_results.json", 'w', encoding='utf-8') as f:
            json.dump(training_results, f, indent=2)

        logger.info("Model saved to %s", model_path)

    def evaluate_model(self) -> Dict:
        """Evaluate trained model performance."""
        logger.info("Evaluating model performance...")

        # Load model and data
        model_path = self.models_dir / "gi_model.joblib"
        if not model_path.exists():
            raise FileNotFoundError("Model not found. Train the model first.")

        model = joblib.load(model_path)

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

        # Detailed report
        evaluation = {
            'accuracy': accuracy,
            'classification_report': classification_report(label_test, predictions, output_dict=True),
            'confusion_matrix': confusion_matrix(label_test, predictions).tolist(),
            'feature_importance': pd.DataFrame({
                'feature': ['text_length', 'word_count'] + self.analyzer.gi_checklist["mandatory_terms"] + self.analyzer.gi_checklist["optional_terms"],
                'importance': model.feature_importances_
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
    parser = argparse.ArgumentParser(description='Train Random Forest model for GI document analysis')
    parser.add_argument('--prepare-data', action='store_true', help='Prepare training data')
    parser.add_argument('--train', action='store_true', help='Train the model')
    parser.add_argument('--evaluate', action='store_true', help='Evaluate the model')
    parser.add_argument('--full-pipeline', action='store_true', help='Run complete pipeline')
    parser.add_argument('--create-template', action='store_true', help='Create dataset template')
    parser.add_argument('--data-dir', default='training_data', help='Training data directory')

    args = parser.parse_args()

    trainer = GIDocumentTrainer(args.data_dir)

    if args.create_template:
        trainer.create_real_dataset_template()
        return

    if args.full_pipeline:
        logger.info("Running full training pipeline...")
        feature_matrix, labels = trainer.prepare_training_data()
        results = trainer.train_model(feature_matrix, labels)
        trainer.save_model(results)
        evaluation = trainer.evaluate_model()
        print("\nTraining completed successfully!")
        print(f"Model accuracy: {results['accuracy']:.3f}")
        print(f"Cross-validation score: {results['cv_mean']:.3f} ± {results['cv_std']:.3f}")
        return

    if args.prepare_data:
        trainer.prepare_training_data()

    if args.train:
        results = trainer.train_model()
        trainer.save_model(results)

    if args.evaluate:
        evaluation = trainer.evaluate_model()
        print("Evaluation Results:")
        print(f"Accuracy: {evaluation['accuracy']:.3f}")
        print("Top Features:")
        for feat in evaluation['feature_importance']:
            print(f"  {feat['feature']}: {feat['importance']:.3f}")

if __name__ == "__main__":
    main()
