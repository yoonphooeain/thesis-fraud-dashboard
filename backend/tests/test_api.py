from __future__ import annotations

import os
import tempfile
from pathlib import Path


TEST_DB = Path(tempfile.gettempdir()) / "nexagift_api_test.db"
os.environ["NEXAGIFT_DATABASE_PATH"] = str(TEST_DB)
os.environ["NEXAGIFT_ADMIN_PASSWORD"] = "test-admin-password"

from fastapi.testclient import TestClient

from app.database import connect, iso_now
from app.main import app


def normal_payload() -> dict[str, object]:
    return {
        "user_id": "USR-TEST-NORMAL",
        "gift_card_category": "NexaGame",
        "card_value_mmk": 25_000,
        "quantity": 1,
        "new_device": 0,
        "device_trust_score": 0.95,
        "failed_login_count_24h": 0,
        "transactions_1h": 1,
        "payment_risk_score": 0.05,
    }


def takeover_payload() -> dict[str, object]:
    return {
        "user_id": "USR-TEST-ATO",
        "gift_card_category": "NexaShop",
        "card_value_mmk": 200_000,
        "quantity": 5,
        "new_device": 1,
        "device_trust_score": 0.05,
        "failed_login_count_24h": 9,
        "ip_country_change": 1,
        "billing_ip_mismatch": 1,
        "vpn_or_proxy": 1,
        "impossible_travel": 1,
        "password_changed_24h": 1,
        "email_changed_24h": 1,
        "delivery_email_changed": 1,
        "transactions_1h": 7,
        "transactions_24h": 12,
        "gift_card_amount_24h_mmk": 1_000_000,
        "payment_method_age_days": 1,
        "payment_decline_count_24h": 7,
        "payment_risk_score": 0.98,
        "has_prior_chargeback": 1,
    }


def test_health_prediction_and_admin_audit() -> None:
    TEST_DB.unlink(missing_ok=True)
    with TestClient(app) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["model_loaded"] is True

        normal = client.post("/predict", json=normal_payload())
        assert normal.status_code == 200
        assert 0 <= normal.json()["risk_score"] <= 100
        assert len(normal.json()["explanation"]) > 0

        takeover = client.post("/predict", json=takeover_payload())
        assert takeover.status_code == 200
        assert takeover.json()["decision"] == "Block"
        assert takeover.json()["simulated_code_released"] is False

        login = client.post(
            "/auth/login",
            json={"username": "admin", "password": "test-admin-password"},
        )
        assert login.status_code == 200
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        transactions = client.get("/transactions", headers=headers)
        assert transactions.status_code == 200
        assert len(transactions.json()) >= 2
        audit = client.get("/audit", headers=headers)
        assert audit.status_code == 200
        assert any(item["action"] == "prediction" for item in audit.json())


def test_otp_and_manual_review_workflows() -> None:
    TEST_DB.unlink(missing_ok=True)
    with TestClient(app) as client:
        now = iso_now()
        with connect() as db:
            for transaction_id, decision, status_value in (
                ("NX-OTP-TEST", "OTP Required", "otp_pending"),
                ("NX-REVIEW-TEST", "Manual Review", "review_pending"),
            ):
                db.execute(
                    """
                    INSERT INTO transactions(
                        transaction_id, user_id, payload, fraud_probability,
                        risk_score, decision, status, explanation, created_at,
                        updated_at
                    ) VALUES (?, 'USR-TEST', '{}', 0.5, 50, ?, ?, '[]', ?, ?)
                    """,
                    (transaction_id, decision, status_value, now, now),
                )
            db.execute(
                """
                INSERT INTO reviews(transaction_id, status, updated_at)
                VALUES ('NX-REVIEW-TEST', 'pending', ?)
                """,
                (now,),
            )

        challenge = client.post(
            "/otp/request", json={"transaction_id": "NX-OTP-TEST"}
        )
        assert challenge.status_code == 200
        code = challenge.json()["demo_code"]
        verified = client.post(
            "/otp/verify",
            json={"transaction_id": "NX-OTP-TEST", "code": code},
        )
        assert verified.status_code == 200
        assert verified.json()["simulated_code_released"] is True

        login = client.post(
            "/auth/login",
            json={"username": "admin", "password": "test-admin-password"},
        )
        headers = {"Authorization": f"Bearer {login.json()['token']}"}
        reviewed = client.post(
            "/reviews/NX-REVIEW-TEST/decision",
            headers=headers,
            json={"action": "approve", "reason": "Evidence verified"},
        )
        assert reviewed.status_code == 200
        assert reviewed.json()["status"] == "released_after_review"
        assert reviewed.json()["simulated_code_released"] is True
