from __future__ import annotations

import csv
import hashlib
import hmac
import json
import secrets
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import (
    audit,
    authenticate,
    connect,
    initialise_database,
    iso_now,
    utc_now,
    validate_session,
)
from .model_service import ModelService, make_simulated_code, make_transaction_id
from .schemas import (
    HealthResponse,
    LoginRequest,
    LoginResponse,
    OtpRequest,
    OtpVerifyRequest,
    PredictionRequest,
    PredictionResponse,
    ReviewDecisionRequest,
)


model_service = ModelService()


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialise_database()
    model_service.load()
    yield


app = FastAPI(
    title="NexaGift Explainable Fraud API",
    version="1.0.0",
    description=(
        "Synthetic research API for account takeover and digital gift-card "
        "transaction fraud detection."
    ),
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allow_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_admin(
    authorization: Annotated[str | None, Header()] = None,
):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Admin token required")
    admin = validate_session(authorization.removeprefix("Bearer ").strip())
    if not admin:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return admin


def otp_hash(transaction_id: str, code: str) -> str:
    return hmac.new(
        settings.otp_secret.encode(),
        f"{transaction_id}:{code}".encode(),
        hashlib.sha256,
    ).hexdigest()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model_loaded=model_service.loaded,
        model_name=model_service.model_name,
        dataset_type="synthetic",
    )


@app.post("/auth/login", response_model=LoginResponse)
def login(request: LoginRequest) -> LoginResponse:
    authenticated = authenticate(request.username, request.password)
    if not authenticated:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token, role, expires_at = authenticated
    audit(request.username, "admin_login", None, {"role": role})
    return LoginResponse(token=token, role=role, expires_at=expires_at)


@app.get("/evaluation")
def evaluation() -> dict[str, object]:
    if not model_service.evaluation:
        raise HTTPException(status_code=503, detail="Evaluation artifact unavailable")
    return model_service.evaluation


@app.get("/dataset/summary")
def dataset_summary() -> dict[str, object]:
    summary_path = settings.data_dir / "dataset_summary.json"
    if not summary_path.exists():
        raise HTTPException(status_code=404, detail="Dataset summary unavailable")
    return json.loads(summary_path.read_text(encoding="utf-8"))


@app.get("/dataset/samples")
def dataset_samples(limit: int = 8) -> list[dict[str, object]]:
    dataset_path = settings.data_dir / "nexagift_test.csv"
    if not dataset_path.exists():
        raise HTTPException(status_code=404, detail="Dataset sample unavailable")

    limit = max(1, min(limit, 20))
    samples: list[dict[str, object]] = []
    preferred_types = {
        "legitimate",
        "account_takeover",
        "stolen_payment",
        "bot_card_testing",
        "geo_velocity",
        "high_velocity_purchase",
    }
    seen_types: set[str] = set()

    with dataset_path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            fraud_type = row["fraud_type"]
            if fraud_type not in preferred_types or fraud_type in seen_types:
                continue
            seen_types.add(fraud_type)
            samples.append(dataset_row_to_sample(row))
            if len(samples) >= limit:
                break

    return samples


@app.post("/predict", response_model=PredictionResponse)
def predict(request: PredictionRequest) -> PredictionResponse:
    if not model_service.loaded:
        raise HTTPException(
            status_code=503,
            detail="Train models before requesting predictions",
        )
    transaction_id = request.transaction_id or make_transaction_id()
    probability, score, decision, explanation = model_service.predict(request)
    released = decision == "Allow"
    simulated_code = make_simulated_code() if released else None
    status_value = {
        "Allow": "released",
        "OTP Required": "otp_pending",
        "Manual Review": "review_pending",
        "Block": "blocked",
    }[decision]
    payload = request.model_dump()
    with connect() as db:
        db.execute(
            """
            INSERT OR REPLACE INTO transactions(
                transaction_id, user_id, payload, fraud_probability, risk_score,
                decision, status, explanation, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                transaction_id,
                request.user_id,
                json.dumps(payload),
                probability,
                score,
                decision,
                status_value,
                json.dumps([item.model_dump() for item in explanation]),
                iso_now(),
                iso_now(),
            ),
        )
        if decision == "Manual Review":
            db.execute(
                """
                INSERT OR REPLACE INTO reviews(
                    transaction_id, status, updated_at
                ) VALUES (?, 'pending', ?)
                """,
                (transaction_id, iso_now()),
            )
    audit(
        "risk_engine",
        "prediction",
        transaction_id,
        {"probability": probability, "risk_score": score, "decision": decision},
    )
    return PredictionResponse(
        transaction_id=transaction_id,
        fraud_probability=round(probability, 6),
        model_threshold=float(model_service.metadata["threshold"]),
        risk_score=score,
        decision=decision,
        model_name=str(model_service.model_name),
        explanation=explanation,
        simulated_code_released=released,
        simulated_code=simulated_code,
    )


def dataset_row_to_sample(row: dict[str, str]) -> dict[str, object]:
    payload = {
        "transaction_id": row["transaction_id"],
        "user_id": row["user_id"],
        "gift_card_category": row["gift_card_category"],
        "card_value_mmk": int(row["card_value_mmk"]),
        "quantity": int(row["quantity"]),
        "total_amount_mmk": int(row["total_amount_mmk"]),
        "account_age_days": int(row["account_age_days"]),
        "account_segment": row["account_segment"],
        "purchase_hour": int(row["purchase_hour"]),
        "is_weekend": int(row["is_weekend"]),
        "new_device": int(row["new_device"]),
        "device_trust_score": float(row["device_trust_score"]),
        "failed_login_count_24h": int(row["failed_login_count_24h"]),
        "ip_country_change": int(row["ip_country_change"]),
        "billing_ip_mismatch": int(row["billing_ip_mismatch"]),
        "vpn_or_proxy": int(row["vpn_or_proxy"]),
        "impossible_travel": int(row["impossible_travel"]),
        "password_changed_24h": int(row["password_changed_24h"]),
        "email_changed_24h": int(row["email_changed_24h"]),
        "delivery_email_changed": int(row["delivery_email_changed"]),
        "transactions_1h": int(row["transactions_1h"]),
        "transactions_24h": int(row["transactions_24h"]),
        "gift_card_amount_24h_mmk": int(row["gift_card_amount_24h_mmk"]),
        "avg_transaction_amount_30d_mmk": float(
            row["avg_transaction_amount_30d_mmk"]
        ),
        "amount_deviation_ratio": float(row["amount_deviation_ratio"]),
        "payment_method_age_days": int(row["payment_method_age_days"]),
        "payment_decline_count_24h": int(row["payment_decline_count_24h"]),
        "payment_risk_score": float(row["payment_risk_score"]),
        "has_prior_chargeback": int(row["has_prior_chargeback"]),
    }
    return {
        "transaction_id": row["transaction_id"],
        "user_id": row["user_id"],
        "transaction_time": row["transaction_time"],
        "gift_card_category": row["gift_card_category"],
        "total_amount_mmk": int(row["total_amount_mmk"]),
        "fraud_family": row["fraud_family"],
        "fraud_type": row["fraud_type"],
        "is_fraud": int(row["is_fraud"]),
        "payload": payload,
    }


@app.post("/otp/request")
def request_otp(request: OtpRequest) -> dict[str, object]:
    with connect() as db:
        transaction = db.execute(
            "SELECT * FROM transactions WHERE transaction_id = ?",
            (request.transaction_id,),
        ).fetchone()
        if not transaction:
            raise HTTPException(status_code=404, detail="Transaction not found")
        if transaction["decision"] != "OTP Required":
            raise HTTPException(status_code=409, detail="OTP is not required")
        code = f"{secrets.randbelow(1_000_000):06d}"
        expires_at = utc_now() + timedelta(minutes=5)
        db.execute(
            """
            INSERT OR REPLACE INTO otp_challenges(
                transaction_id, code_hash, expires_at, attempts, consumed, created_at
            ) VALUES (?, ?, ?, 0, 0, ?)
            """,
            (
                request.transaction_id,
                otp_hash(request.transaction_id, code),
                expires_at.isoformat(),
                iso_now(),
            ),
        )
    audit("otp_service", "otp_requested", request.transaction_id, {})
    return {
        "transaction_id": request.transaction_id,
        "expires_at": expires_at.isoformat(),
        "max_attempts": 3,
        "demo_code": code,
        "warning": "demo_code is returned only for the local thesis prototype",
    }


@app.post("/otp/verify")
def verify_otp(request: OtpVerifyRequest) -> dict[str, object]:
    with connect() as db:
        challenge = db.execute(
            "SELECT * FROM otp_challenges WHERE transaction_id = ?",
            (request.transaction_id,),
        ).fetchone()
        if not challenge:
            raise HTTPException(status_code=404, detail="OTP challenge not found")
        if challenge["consumed"]:
            raise HTTPException(status_code=409, detail="OTP already consumed")
        if challenge["expires_at"] <= iso_now():
            raise HTTPException(status_code=410, detail="OTP expired")
        if challenge["attempts"] >= 3:
            raise HTTPException(status_code=423, detail="OTP attempt limit reached")
        valid = hmac.compare_digest(
            challenge["code_hash"],
            otp_hash(request.transaction_id, request.code),
        )
        db.execute(
            """
            UPDATE otp_challenges
            SET attempts = attempts + 1, consumed = ?
            WHERE transaction_id = ?
            """,
            (int(valid), request.transaction_id),
        )
        if not valid:
            audit("otp_service", "otp_failed", request.transaction_id, {})
            raise HTTPException(status_code=401, detail="Incorrect OTP")
        code = make_simulated_code()
        db.execute(
            """
            UPDATE transactions
            SET status = 'released_after_otp', updated_at = ?
            WHERE transaction_id = ?
            """,
            (iso_now(), request.transaction_id),
        )
    audit("otp_service", "otp_verified", request.transaction_id, {})
    return {
        "verified": True,
        "simulated_code_released": True,
        "simulated_code": code,
    }


@app.get("/transactions")
def transactions(
    admin=Depends(require_admin),
) -> list[dict[str, object]]:
    with connect() as db:
        rows = db.execute(
            """
            SELECT transaction_id, user_id, fraud_probability, risk_score,
                   decision, status, explanation, created_at, updated_at
            FROM transactions ORDER BY created_at DESC LIMIT 100
            """
        ).fetchall()
    audit(admin["username"], "transactions_viewed", None, {})
    return [
        {
            **dict(row),
            "explanation": json.loads(row["explanation"]),
        }
        for row in rows
    ]


@app.post("/reviews/{transaction_id}/decision")
def review_decision(
    transaction_id: str,
    request: ReviewDecisionRequest,
    admin=Depends(require_admin),
) -> dict[str, object]:
    with connect() as db:
        review = db.execute(
            "SELECT * FROM reviews WHERE transaction_id = ?", (transaction_id,)
        ).fetchone()
        if not review:
            raise HTTPException(status_code=404, detail="Review case not found")
        review_status = {
            "approve": "approved",
            "reject": "rejected",
            "block": "blocked",
        }[request.action]
        transaction_status = (
            "released_after_review"
            if request.action == "approve"
            else review_status
        )
        db.execute(
            """
            UPDATE reviews SET status = ?, reviewer_id = ?, reason = ?, updated_at = ?
            WHERE transaction_id = ?
            """,
            (
                review_status,
                admin["id"],
                request.reason,
                iso_now(),
                transaction_id,
            ),
        )
        db.execute(
            """
            UPDATE transactions SET status = ?, updated_at = ?
            WHERE transaction_id = ?
            """,
            (transaction_status, iso_now(), transaction_id),
        )
    audit(
        admin["username"],
        f"review_{request.action}",
        transaction_id,
        {"reason": request.reason},
    )
    return {
        "transaction_id": transaction_id,
        "status": transaction_status,
        "simulated_code_released": request.action == "approve",
        "simulated_code": (
            make_simulated_code() if request.action == "approve" else None
        ),
    }


@app.get("/audit")
def audit_log(admin=Depends(require_admin)) -> list[dict[str, object]]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT 200"
        ).fetchall()
    return [
        {
            **dict(row),
            "details": json.loads(row["details"]),
        }
        for row in rows
    ]
