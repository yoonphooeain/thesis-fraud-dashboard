from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
import shap
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    f1_score,
    matthews_corrcoef,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from xgboost import XGBClassifier


ROOT = Path(__file__).resolve().parents[1]
TARGET = "is_fraud"
CATEGORICAL = ["gift_card_category", "account_segment"]
EXCLUDED = [
    "transaction_id",
    "user_id",
    "transaction_time",
    "fraud_family",
    "fraud_type",
    TARGET,
]
TRANSACTION_ONLY = [
    "gift_card_category",
    "card_value_mmk",
    "quantity",
    "total_amount_mmk",
    "purchase_hour",
    "is_weekend",
]
LOGIN_TRANSACTION = TRANSACTION_ONLY + [
    "new_device",
    "device_trust_score",
    "failed_login_count_24h",
    "ip_country_change",
    "vpn_or_proxy",
    "impossible_travel",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train and evaluate NexaGift fraud models."
    )
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--artifacts-dir", type=Path, default=ROOT / "artifacts")
    parser.add_argument("--seed", type=int, default=20260723)
    return parser.parse_args()


def make_preprocessor(columns: list[str]) -> ColumnTransformer:
    categorical = [column for column in CATEGORICAL if column in columns]
    numeric = [column for column in columns if column not in categorical]
    return ColumnTransformer(
        [
            (
                "numeric",
                Pipeline([("scale", StandardScaler())]),
                numeric,
            ),
            (
                "categorical",
                OneHotEncoder(handle_unknown="ignore", sparse_output=False),
                categorical,
            ),
        ],
        verbose_feature_names_out=False,
    )


def make_models(positive_weight: float, seed: int) -> dict[str, Any]:
    return {
        "Logistic Regression": LogisticRegression(
            max_iter=1_500,
            class_weight="balanced",
            random_state=seed,
        ),
        "Random Forest": RandomForestClassifier(
            n_estimators=280,
            max_depth=14,
            min_samples_leaf=3,
            class_weight="balanced_subsample",
            n_jobs=-1,
            random_state=seed,
        ),
        "XGBoost": XGBClassifier(
            n_estimators=320,
            max_depth=5,
            learning_rate=0.055,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_lambda=2.0,
            scale_pos_weight=positive_weight,
            eval_metric="logloss",
            n_jobs=-1,
            random_state=seed,
        ),
    }


def select_threshold(labels: pd.Series, probabilities: np.ndarray) -> float:
    precision, recall, thresholds = precision_recall_curve(labels, probabilities)
    scores = 2 * precision[:-1] * recall[:-1] / (
        precision[:-1] + recall[:-1] + 1e-12
    )
    eligible = np.where(recall[:-1] >= 0.75)[0]
    index = int(eligible[np.argmax(scores[eligible])]) if len(eligible) else int(np.argmax(scores))
    return float(thresholds[index])


def evaluate(
    labels: pd.Series, probabilities: np.ndarray, threshold: float
) -> dict[str, Any]:
    predictions = (probabilities >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(labels, predictions).ravel()
    return {
        "pr_auc": float(average_precision_score(labels, probabilities)),
        "roc_auc": float(roc_auc_score(labels, probabilities)),
        "precision": float(precision_score(labels, predictions, zero_division=0)),
        "recall": float(recall_score(labels, predictions, zero_division=0)),
        "f1": float(f1_score(labels, predictions, zero_division=0)),
        "mcc": float(matthews_corrcoef(labels, predictions)),
        "fpr": float(fp / (fp + tn)),
        "threshold": threshold,
        "confusion_matrix": {
            "tn": int(tn),
            "fp": int(fp),
            "fn": int(fn),
            "tp": int(tp),
        },
    }


def curve_points(labels: pd.Series, probabilities: np.ndarray) -> list[dict[str, float]]:
    precision, recall, _ = precision_recall_curve(labels, probabilities)
    indexes = np.linspace(0, len(precision) - 1, min(80, len(precision))).astype(int)
    return [
        {"recall": float(recall[index]), "precision": float(precision[index])}
        for index in indexes
    ]


def scenario_recall(
    frame: pd.DataFrame, probabilities: np.ndarray, threshold: float
) -> dict[str, float]:
    predictions = probabilities >= threshold
    values: dict[str, float] = {}
    for fraud_type, group in frame[frame[TARGET] == 1].groupby("fraud_type"):
        indexes = group.index.to_numpy()
        values[str(fraud_type)] = float(predictions[indexes].mean())
    return values


def fit_ablation(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    columns: list[str],
    positive_weight: float,
    seed: int,
) -> float:
    model = Pipeline(
        [
            ("preprocessor", make_preprocessor(columns)),
            (
                "classifier",
                XGBClassifier(
                    n_estimators=220,
                    max_depth=4,
                    learning_rate=0.07,
                    scale_pos_weight=positive_weight,
                    eval_metric="logloss",
                    n_jobs=-1,
                    random_state=seed,
                ),
            ),
        ]
    )
    model.fit(train[columns], train[TARGET])
    probabilities = model.predict_proba(validation[columns])[:, 1]
    return float(average_precision_score(validation[TARGET], probabilities))


def build_shap_artifacts(
    pipeline: Pipeline,
    sample: pd.DataFrame,
    artifacts_dir: Path,
) -> dict[str, float]:
    preprocessor = pipeline.named_steps["preprocessor"]
    classifier = pipeline.named_steps["classifier"]
    transformed = preprocessor.transform(sample)
    feature_names = list(preprocessor.get_feature_names_out())
    background = transformed[: min(120, len(transformed))]
    explain_rows = transformed[: min(300, len(transformed))]
    if hasattr(classifier, "feature_importances_"):
        explainer = shap.TreeExplainer(classifier)
    else:
        explainer = shap.LinearExplainer(classifier, background)
    started = time.perf_counter()
    explanation = explainer(explain_rows)
    mean_shap_ms = (
        (time.perf_counter() - started) * 1_000 / max(len(explain_rows), 1)
    )
    values = np.asarray(explanation.values)
    if values.ndim == 3:
        values = values[:, :, -1]
    global_values = np.mean(np.abs(values), axis=0)
    order = np.argsort(global_values)[::-1]
    global_payload = [
        {
            "feature": feature_names[index],
            "mean_abs_shap": float(global_values[index]),
        }
        for index in order[:20]
    ]
    local_payload = []
    for row_index in range(min(12, len(explain_rows))):
        row_order = np.argsort(np.abs(values[row_index]))[::-1][:10]
        local_payload.append(
            {
                "row": row_index,
                "features": [
                    {
                        "feature": feature_names[index],
                        "value": float(explain_rows[row_index][index]),
                        "shap_value": float(values[row_index][index]),
                    }
                    for index in row_order
                ],
            }
        )
    (artifacts_dir / "shap_global.json").write_text(
        json.dumps(global_payload, indent=2), encoding="utf-8"
    )
    (artifacts_dir / "shap_local_examples.json").write_text(
        json.dumps(local_payload, indent=2), encoding="utf-8"
    )
    return {"mean_shap_ms": mean_shap_ms}


def main() -> None:
    args = parse_args()
    args.artifacts_dir.mkdir(parents=True, exist_ok=True)
    train = pd.read_csv(args.data_dir / "nexagift_train.csv")
    validation = pd.read_csv(args.data_dir / "nexagift_validation.csv")
    test = pd.read_csv(args.data_dir / "nexagift_test.csv").reset_index(drop=True)
    columns = [column for column in train.columns if column not in EXCLUDED]
    positive_weight = float(
        (train[TARGET] == 0).sum() / max((train[TARGET] == 1).sum(), 1)
    )

    validation_results: dict[str, Any] = {}
    fitted: dict[str, Pipeline] = {}
    for name, classifier in make_models(positive_weight, args.seed).items():
        pipeline = Pipeline(
            [
                ("preprocessor", make_preprocessor(columns)),
                ("classifier", classifier),
            ]
        )
        started = time.perf_counter()
        pipeline.fit(train[columns], train[TARGET])
        train_ms = (time.perf_counter() - started) * 1_000
        probabilities = pipeline.predict_proba(validation[columns])[:, 1]
        threshold = select_threshold(validation[TARGET], probabilities)
        metrics = evaluate(validation[TARGET], probabilities, threshold)
        metrics["train_ms"] = train_ms
        metrics["pr_curve"] = curve_points(validation[TARGET], probabilities)
        metrics["scenario_recall"] = scenario_recall(
            validation.reset_index(drop=True), probabilities, threshold
        )
        validation_results[name] = metrics
        fitted[name] = pipeline

    best_name = max(
        validation_results,
        key=lambda name: (
            validation_results[name]["pr_auc"],
            validation_results[name]["recall"],
            -validation_results[name]["fpr"],
        ),
    )
    best_pipeline = fitted[best_name]
    threshold = float(validation_results[best_name]["threshold"])

    started = time.perf_counter()
    test_probabilities = best_pipeline.predict_proba(test[columns])[:, 1]
    prediction_ms = (time.perf_counter() - started) * 1_000 / len(test)
    test_metrics = evaluate(test[TARGET], test_probabilities, threshold)
    test_metrics["mean_prediction_ms"] = prediction_ms
    test_metrics["pr_curve"] = curve_points(test[TARGET], test_probabilities)
    test_metrics["scenario_recall"] = scenario_recall(
        test, test_probabilities, threshold
    )

    ablation = {
        "transaction_only_pr_auc": fit_ablation(
            train,
            validation,
            TRANSACTION_ONLY,
            positive_weight,
            args.seed,
        ),
        "login_transaction_pr_auc": fit_ablation(
            train,
            validation,
            LOGIN_TRANSACTION,
            positive_weight,
            args.seed,
        ),
        "all_features_pr_auc": float(validation_results[best_name]["pr_auc"]),
    }

    joblib.dump(best_pipeline, args.artifacts_dir / "fraud_pipeline.joblib")
    metadata = {
        "model_name": best_name,
        "model_version": "1.0.0",
        "dataset_type": "synthetic",
        "feature_columns": columns,
        "threshold": threshold,
        "selection_rule": (
            "Highest validation PR-AUC, then Recall, then lower FPR"
        ),
        "test_set_policy": "Locked test set opened once after model selection",
    }
    evaluation = {
        "validation": validation_results,
        "selected_model": best_name,
        "locked_test": test_metrics,
        "feature_ablation": ablation,
        "fraud_prevalence": float(test[TARGET].mean()),
    }
    (args.artifacts_dir / "metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    shap_timing = build_shap_artifacts(
        best_pipeline, test[columns], args.artifacts_dir
    )
    evaluation["locked_test"]["mean_shap_ms"] = shap_timing["mean_shap_ms"]
    evaluation["locked_test"]["mean_end_to_end_ms"] = (
        prediction_ms + shap_timing["mean_shap_ms"]
    )
    (args.artifacts_dir / "evaluation.json").write_text(
        json.dumps(evaluation, indent=2), encoding="utf-8"
    )
    print(json.dumps({"metadata": metadata, "evaluation": evaluation}, indent=2))


if __name__ == "__main__":
    main()
