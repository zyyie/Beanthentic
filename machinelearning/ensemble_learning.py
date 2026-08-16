#!/usr/bin/env python3
"""
Ensemble learning for Beanthentic GI readiness models.

Theory (capstone basis)
-----------------------
Ensemble learning combines several base learners so the committee decision is
more stable than any single model:

1. **Bagging** (Bootstrap Aggregating) — train many trees on bootstrap samples
   and average votes. Used here via ``RandomForestClassifier`` and
   ``ExtraTreesClassifier``. Reduces variance.
2. **Boosting** — train trees sequentially, each focusing on prior residuals /
   hard examples. Used here via ``GradientBoostingClassifier``. Reduces bias.
3. **Soft voting** — average class probabilities from heterogeneous learners
   (bagging + boosting). Final Ready / Not Ready = argmax of the mean
   probability vector. Diversity among base models is the key assumption.

Beanthentic therefore does *not* train a lone decision tree. Farmer CSV and
document MoP pipelines both fit a soft-voting ensemble and persist it as the
``*.joblib`` artifact used by ``ai_engine.GIAnalyzer``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from sklearn.ensemble import (
    ExtraTreesClassifier,
    GradientBoostingClassifier,
    RandomForestClassifier,
    VotingClassifier,
)

ENSEMBLE_METHOD = "soft_voting_bagging_boosting"
ENSEMBLE_DESCRIPTION = (
    "Soft-voting ensemble: Random Forest (bagging) + Extra Trees (bagging) + "
    "Gradient Boosting (boosting). Class probabilities are averaged; the "
    "majority-ready probability becomes the advisory ML score."
)


def build_gi_ensemble(
    *,
    random_state: int = 42,
    class_weight: str | None = "balanced",
    n_estimators: int = 150,
    max_depth: int | None = 20,
    learning_rate: float = 0.08,
    include_boosting: bool = True,
) -> VotingClassifier:
    """
    Build an unfitted soft-voting ensemble grounded in bagging + boosting.

    Weights slightly favor Random Forest (2) over Extra Trees / Gradient Boosting
    (1 each) so SHAP explanations stay aligned with the primary bagging member.
    """
    import os

    tree_jobs = 1 if os.name == "nt" else -1
    rf = RandomForestClassifier(
        n_estimators=n_estimators,
        max_depth=max_depth,
        min_samples_split=2,
        min_samples_leaf=1,
        max_features="sqrt",
        class_weight=class_weight,
        random_state=random_state,
        n_jobs=tree_jobs,
    )
    et = ExtraTreesClassifier(
        n_estimators=max(80, n_estimators // 2),
        max_depth=max_depth,
        min_samples_split=2,
        min_samples_leaf=1,
        max_features="sqrt",
        class_weight=class_weight,
        random_state=random_state + 1,
        n_jobs=tree_jobs,
    )
    estimators = [("rf", rf), ("et", et)]
    weights = [2, 1]
    if include_boosting:
        # Gradient boosting has no class_weight; keep defaults modest for small MoP sets.
        gb = GradientBoostingClassifier(
            n_estimators=max(60, n_estimators // 2),
            learning_rate=learning_rate,
            max_depth=3 if max_depth is None else min(3, max_depth),
            random_state=random_state + 2,
        )
        estimators.append(("gb", gb))
        weights.append(1)
    return VotingClassifier(
        estimators=estimators,
        voting="soft",
        weights=weights,
    )


def ensemble_param_grid(*, compact: bool = True) -> dict[str, list[Any]]:
    """Grid keys target the Random Forest member inside the voting ensemble."""
    if compact:
        return {
            "rf__n_estimators": [100, 200],
            "rf__max_depth": [12, 20, None],
            "rf__min_samples_split": [2, 5],
            "rf__min_samples_leaf": [1, 2],
        }
    return {
        "rf__n_estimators": [50, 100, 200],
        "rf__max_depth": [10, 20, None],
        "rf__min_samples_split": [2, 5, 10],
        "rf__min_samples_leaf": [1, 2, 4],
        "rf__max_features": ["sqrt", "log2"],
        "gb__learning_rate": [0.05, 0.1],
    }


def tree_estimator_for_shap(model: Any) -> Any:
    """
    Return a tree model SHAP can explain.

    Soft-voting ensembles are not TreeExplainer-compatible as a whole; use the
    Random Forest (bagging) member when present.
    """
    if model is None:
        return None
    named = getattr(model, "named_estimators_", None)
    if isinstance(named, dict) and "rf" in named:
        return named["rf"]
    if hasattr(model, "estimators_") and model.estimators_:
        for est in model.estimators_:
            # VotingClassifier.estimators_ is list[(name, estimator)] after fit
            candidate = est[1] if isinstance(est, tuple) and len(est) == 2 else est
            if hasattr(candidate, "feature_importances_"):
                return candidate
    if hasattr(model, "feature_importances_"):
        return model
    return model


def ensemble_feature_importances(model: Any, n_features: int | None = None) -> np.ndarray:
    """
    Aggregate feature importances across bagging/boosting members that expose them.

    Soft-voting members without ``feature_importances_`` are skipped. Importances
    are averaged and L1-normalized so callers can treat the vector like RF output.
    """
    importances: list[np.ndarray] = []
    named = getattr(model, "named_estimators_", None)
    if isinstance(named, dict):
        candidates = list(named.values())
    elif hasattr(model, "estimators_") and model.estimators_:
        candidates = [
            (est[1] if isinstance(est, tuple) and len(est) == 2 else est)
            for est in model.estimators_
        ]
    else:
        candidates = [model]

    for est in candidates:
        if hasattr(est, "feature_importances_"):
            vals = np.asarray(est.feature_importances_, dtype=float)
            if n_features is not None and len(vals) != n_features:
                continue
            importances.append(vals)

    if not importances:
        size = n_features or 0
        return np.zeros(size, dtype=float)

    avg = np.mean(np.vstack(importances), axis=0)
    total = float(avg.sum())
    if total > 0:
        avg = avg / total
    return avg


def describe_ensemble(model: Any) -> dict[str, Any]:
    """Metadata for training_results.json / capstone write-ups."""
    members: list[str] = []
    named = getattr(model, "named_estimators_", None)
    if isinstance(named, dict):
        members = [f"{name}:{type(est).__name__}" for name, est in named.items()]
    elif hasattr(model, "estimators"):
        members = [f"{name}:{type(est).__name__}" for name, est in model.estimators]

    return {
        "ensemble_method": ENSEMBLE_METHOD,
        "ensemble_description": ENSEMBLE_DESCRIPTION,
        "voting": getattr(model, "voting", None),
        "weights": list(getattr(model, "weights", []) or []),
        "base_learners": members,
        "theory": {
            "bagging": ["RandomForestClassifier", "ExtraTreesClassifier"],
            "boosting": ["GradientBoostingClassifier"],
            "combination_rule": "soft_voting_mean_probability",
        },
    }
