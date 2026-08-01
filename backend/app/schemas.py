from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


Decision = Literal["Allow", "OTP Required", "Manual Review", "Block"]


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    role: str
    expires_at: str


class PredictionRequest(BaseModel):
    transaction_id: str | None = None
    user_id: str = "USR-DEMO"
    gift_card_category: Literal[
        "NexaGame", "NexaShop", "NexaEntertainment"
    ] = "NexaGame"
    card_value_mmk: int = Field(50_000, ge=1)
    quantity: int = Field(1, ge=1, le=20)
    total_amount_mmk: int | None = Field(None, ge=1)
    account_age_days: int = Field(365, ge=0)
    account_segment: Literal["new", "regular", "established"] = "regular"
    purchase_hour: int = Field(12, ge=0, le=23)
    is_weekend: int = Field(0, ge=0, le=1)
    new_device: int = Field(0, ge=0, le=1)
    device_trust_score: float = Field(0.9, ge=0, le=1)
    failed_login_count_24h: int = Field(0, ge=0)
    ip_country_change: int = Field(0, ge=0, le=1)
    billing_ip_mismatch: int = Field(0, ge=0, le=1)
    vpn_or_proxy: int = Field(0, ge=0, le=1)
    impossible_travel: int = Field(0, ge=0, le=1)
    password_changed_24h: int = Field(0, ge=0, le=1)
    email_changed_24h: int = Field(0, ge=0, le=1)
    delivery_email_changed: int = Field(0, ge=0, le=1)
    transactions_1h: int = Field(1, ge=0)
    transactions_24h: int = Field(1, ge=0)
    gift_card_amount_24h_mmk: int = Field(50_000, ge=0)
    avg_transaction_amount_30d_mmk: float = Field(50_000, gt=0)
    amount_deviation_ratio: float | None = Field(None, ge=0)
    payment_method_age_days: int = Field(180, ge=0)
    payment_decline_count_24h: int = Field(0, ge=0)
    payment_risk_score: float = Field(0.1, ge=0, le=1)
    has_prior_chargeback: int = Field(0, ge=0, le=1)


class RiskFactor(BaseModel):
    feature: str
    value: float | str
    contribution: float
    direction: Literal["increase", "decrease"]


class PredictionResponse(BaseModel):
    transaction_id: str
    fraud_probability: float
    model_threshold: float
    risk_score: float
    decision: Decision
    model_name: str
    explanation: list[RiskFactor]
    simulated_code_released: bool
    simulated_code: str | None = None


class OtpRequest(BaseModel):
    transaction_id: str


class OtpVerifyRequest(BaseModel):
    transaction_id: str
    code: str = Field(min_length=6, max_length=6)


class ReviewDecisionRequest(BaseModel):
    action: Literal["approve", "reject", "block"]
    reason: str = Field(min_length=3, max_length=500)


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    model_name: str | None
    dataset_type: str
