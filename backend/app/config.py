from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path(os.getenv("NEXAGIFT_DATA_DIR", ROOT / "data"))
    artifacts_dir: Path = Path(
        os.getenv("NEXAGIFT_ARTIFACTS_DIR", ROOT / "artifacts")
    )
    database_path: Path = Path(
        os.getenv("NEXAGIFT_DATABASE_PATH", ROOT / "nexagift.db")
    )
    admin_username: str = os.getenv("NEXAGIFT_ADMIN_USERNAME", "admin")
    admin_password: str = os.getenv(
        "NEXAGIFT_ADMIN_PASSWORD", "NexaGift-Local-Admin-2026"
    )
    otp_secret: str = os.getenv(
        "NEXAGIFT_OTP_SECRET", "replace-this-local-thesis-secret"
    )
    allow_origins: tuple[str, ...] = tuple(
        origin.strip()
        for origin in os.getenv(
            "NEXAGIFT_ALLOW_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000",
        ).split(",")
        if origin.strip()
    )


settings = Settings()
