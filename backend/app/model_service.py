from __future__ import annotations

import json
import math
import secrets
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
import shap

from .config import settings
from .schemas import Decision, PredictionRequest, RiskFactor


class ModelService:
    def __init__(self, artifacts_dir: Path | None = None) -> None:
        self.artifacts_dir = artifacts_dir or settings.artifacts_dir
        self.pipeline: Any | None = None
        self.metadata: dict[str, Any] = {}
        self.evaluation: dict[str, Any] = {}
        self.explainer: Any | None = None
        self.feature_names: list[str] = []
        self.load()

    @property
    def loaded(self) -> bool:
        return self.pipeline is not None

    @property
    def model_name(self) -> str | None:
        return self.metadata.get("model_name")

    def load(self) -> None:
        pipeline_path = self.artifacts_dir / "fraud_pipeline.joblib"
        metadata_path = self.artifacts_dir / "metadata.json"
        evaluation_path = self.artifacts_dir / "evaluation.json"
        if not pipeline_path.exists() or not metadata_path.exists():
            return
        self.pipeline = joblib.load(pipeline_path)
        self.metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if evaluation_path.exists():
            self.evaluation = json.loads(
                evaluation_path.read_text(encoding="utf-8")
            )
        preprocessor = self.pipeline.named_steps["preprocessor"]
        classifier = self.pipeline.named_steps["classifier"]
        self.feature_names = list(preprocessor.get_feature_names_out())
        if hasattr(classifier, "feature_importances_"):
            self.explainer = shap.TreeExplainer(classifier)

    def frame_from_request(self, request: PredictionRequest) -> pd.DataFrame:
        payload = request.model_dump()
        total_amount = request.total_amount_mmk or (
            request.card_value_mmk * request.quantity
        )
        payload["total_amount_mmk"] = total_amount
        payload["amount_deviation_ratio"] = (
            request.amount_deviation_ratio
            if request.amount_deviation_ratio is not None
            else total_amount / max(request.avg_transaction_amount_30d_mmk, 1)
        )
        columns = self.metadata["feature_columns"]
        return pd.DataFrame([{column: payload[column] for column in columns}])

    def local_explanation(self, frame: pd.DataFrame) -> list[RiskFactor]:
        assert self.pipeline is not None
        preprocessor = self.pipeline.named_steps["preprocessor"]
        classifier = self.pipeline.named_steps["classifier"]
        transformed = np.asarray(preprocessor.transform(frame))

        if self.explainer is not None:
            explanation = self.explainer(transformed)
            values = np.asarray(explanation.values)
            if values.ndim == 3:
                values = values[:, :, -1]
            contributions = values[0]
        elif hasattr(classifier, "coef_"):
            contributions = transformed[0] * np.asarray(classifier.coef_)[0]
        else:
            contributions = np.zeros(transformed.shape[1])

        order = np.argsort(np.abs(contributions))[::-1][:8]
        factors = []
        for index in order:
            contribution = float(contributions[index])
            value: float | str = float(transformed[0][index])
            factors.append(
                RiskFactor(
                    feature=self.feature_names[index],
                    value=value,
                    contribution=contribution,
                    direction="increase" if contribution >= 0 else "decrease",
                )
            )
        return factors

    @staticmethod
    def risk_score(
        request: PredictionRequest, fraud_probability: float
    ) -> float:
        device_risk = 1 - request.device_trust_score
        login_location_risk = min(
            1.0,
            request.failed_login_count_24h / 10
            + 0.25 * request.ip_country_change
            + 0.45 * request.impossible_travel,
        )
        total = request.total_amount_mmk or (
            request.card_value_mmk * request.quantity
        )
        velocity_risk = min(
            1.0,
            max(request.transactions_1h - 1, 0) / 5 + total / 1_000_000,
        )
        account_change_risk = min(
            1.0,
            0.35 * request.password_changed_24h
            + 0.30 * request.email_changed_24h
            + 0.35 * request.delivery_email_changed,
        )
        score = 100 * (
            0.60 * fraud_probability
            + 0.10 * device_risk
            + 0.10 * login_location_risk
            + 0.10 * velocity_risk
            + 0.10 * account_change_risk
        )
        return round(max(0.0, min(100.0, score)), 2)

    @staticmethod
    def decision(request: PredictionRequest, risk_score: float) -> Decision:
        hard_block = (
            request.impossible_travel
            and request.email_changed_24h
            and request.new_device
        ) or (
            request.payment_decline_count_24h >= 5
            and request.transactions_1h >= 5
        )
        if hard_block or risk_score >= 80:
            return "Block"
        if risk_score >= 60:
            return "Manual Review"
        if risk_score >= 30:
            return "OTP Required"
        return "Allow"

    def predict(
        self, request: PredictionRequest
    ) -> tuple[float, float, Decision, list[RiskFactor]]:
        if self.pipeline is None:
            raise RuntimeError("Model artifact is not available")
        frame = self.frame_from_request(request)
        probability = float(self.pipeline.predict_proba(frame)[:, 1][0])
        score = self.risk_score(request, probability)
        decision = self.decision(request, score)
        return probability, score, decision, self.local_explanation(frame)


def make_transaction_id() -> str:
    return f"NX-{secrets.token_hex(5).upper()}"


def make_simulated_code() -> str:
    return f"NEXA-DEMO-{secrets.token_hex(4).upper()}"


def sigmoid(value: float) -> float:
    return 1 / (1 + math.exp(-value))
