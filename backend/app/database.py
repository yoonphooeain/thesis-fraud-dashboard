from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from .config import settings


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def hash_secret(value: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", value.encode(), salt.encode(), 180_000
    ).hex()


@contextmanager
def connect(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    database_path = path or settings.database_path
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def initialise_database(path: Path | None = None) -> None:
    with connect(path) as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS admins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                admin_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(admin_id) REFERENCES admins(id)
            );
            CREATE TABLE IF NOT EXISTS transactions (
                transaction_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                fraud_probability REAL NOT NULL,
                risk_score REAL NOT NULL,
                decision TEXT NOT NULL,
                status TEXT NOT NULL,
                explanation TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS otp_challenges (
                transaction_id TEXT PRIMARY KEY,
                code_hash TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                consumed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id)
            );
            CREATE TABLE IF NOT EXISTS reviews (
                transaction_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                reviewer_id INTEGER,
                reason TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id),
                FOREIGN KEY(reviewer_id) REFERENCES admins(id)
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                transaction_id TEXT,
                details TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        existing = db.execute(
            "SELECT id FROM admins WHERE username = ?",
            (settings.admin_username,),
        ).fetchone()
        if not existing:
            salt = secrets.token_hex(16)
            db.execute(
                """
                INSERT INTO admins(username, password_hash, salt, role, created_at)
                VALUES (?, ?, ?, 'security_admin', ?)
                """,
                (
                    settings.admin_username,
                    hash_secret(settings.admin_password, salt),
                    salt,
                    iso_now(),
                ),
            )


def authenticate(username: str, password: str) -> tuple[str, str, str] | None:
    with connect() as db:
        admin = db.execute(
            "SELECT * FROM admins WHERE username = ?", (username,)
        ).fetchone()
        if not admin or not hmac.compare_digest(
            admin["password_hash"], hash_secret(password, admin["salt"])
        ):
            return None
        token = secrets.token_urlsafe(32)
        expires_at = utc_now() + timedelta(hours=8)
        db.execute(
            """
            INSERT INTO sessions(token_hash, admin_id, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                hashlib.sha256(token.encode()).hexdigest(),
                admin["id"],
                expires_at.isoformat(),
                iso_now(),
            ),
        )
        return token, admin["role"], expires_at.isoformat()


def validate_session(token: str) -> sqlite3.Row | None:
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with connect() as db:
        return db.execute(
            """
            SELECT admins.id, admins.username, admins.role
            FROM sessions
            JOIN admins ON admins.id = sessions.admin_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            """,
            (token_hash, iso_now()),
        ).fetchone()


def audit(
    actor: str,
    action: str,
    transaction_id: str | None,
    details: dict[str, object],
) -> None:
    with connect() as db:
        db.execute(
            """
            INSERT INTO audit_log(actor, action, transaction_id, details, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (actor, action, transaction_id, json.dumps(details), iso_now()),
        )
