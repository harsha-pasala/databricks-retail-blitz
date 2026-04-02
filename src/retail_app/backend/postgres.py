from __future__ import annotations

import base64
import logging
import os
import time
from contextlib import contextmanager
from decimal import Decimal
from typing import Any

import psycopg2
import psycopg2.extras
import requests

logger = logging.getLogger("retail-app.postgres")

# Connection settings — defaults match the Lakebase used by the training notebook
PG_HOST = os.getenv(
    "PG_HOST",
    os.getenv(
        "DB_HOST",
        "ep-crimson-meadow-e1ckeiiu.database.eastus2.azuredatabricks.net",
    ),
)
PG_PORT = int(os.getenv("PG_PORT", os.getenv("DB_PORT", "5432")))
PG_DB = os.getenv("PG_DB", os.getenv("DB_NAME", "databricks_postgres"))
OIDC_TOKEN_URL = os.getenv(
    "OIDC_TOKEN_URL",
    "https://adb-7405612444656138.18.azuredatabricks.net/oidc/v1/token",
)

TABLE = "customer_features"

# OAuth token cache
_token_cache: dict[str, Any] = {"token": None, "expires_at": 0.0}

# Credential cache (loaded lazily)
_creds: dict[str, str] = {"client_id": "", "client_secret": "", "loaded": ""}


def _ensure_credentials() -> tuple[str, str]:
    """Load SP credentials from env vars or Databricks secrets."""
    if _creds["loaded"]:
        return _creds["client_id"], _creds["client_secret"]

    # Try env vars first
    cid = os.getenv("CLIENT_ID", "")
    csec = os.getenv("CLIENT_SECRET", "")

    if cid and csec:
        _creds["client_id"] = cid
        _creds["client_secret"] = csec
        _creds["loaded"] = "env"
        logger.info("Loaded Lakebase credentials from environment variables")
        return cid, csec

    # Fallback: load from Databricks secrets via SDK
    try:
        from databricks.sdk import WorkspaceClient
        w = WorkspaceClient()
        cid_resp = w.secrets.get_secret(scope="sp_blog", key="client_id")
        csec_resp = w.secrets.get_secret(scope="sp_blog", key="client_secret")
        cid = base64.b64decode(cid_resp.value).decode("utf-8")
        csec = base64.b64decode(csec_resp.value).decode("utf-8")
        _creds["client_id"] = cid
        _creds["client_secret"] = csec
        _creds["loaded"] = "secrets"
        logger.info("Loaded Lakebase credentials from Databricks secrets")
        return cid, csec
    except Exception:
        logger.exception("Failed to load credentials from Databricks secrets")

    _creds["loaded"] = "failed"
    return "", ""


def _get_oauth_token() -> str:
    """Fetch an OAuth token using SP credentials, with simple caching."""
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"] - 60:
        return _token_cache["token"]

    client_id, client_secret = _ensure_credentials()

    resp = requests.post(
        OIDC_TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "all-apis",
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    _token_cache["token"] = data["access_token"]
    _token_cache["expires_at"] = now + data.get("expires_in", 3600)
    return _token_cache["token"]


@contextmanager
def _get_conn():
    client_id, client_secret = _ensure_credentials()

    if client_id and client_secret and OIDC_TOKEN_URL:
        user = client_id
        password = _get_oauth_token()
    else:
        user = os.getenv("PG_USER", "")
        password = os.getenv("PG_PASSWORD", "")

    conn = psycopg2.connect(
        host=PG_HOST,
        port=PG_PORT,
        dbname=PG_DB,
        user=user,
        password=password,
        sslmode="require",
        connect_timeout=10,
    )
    try:
        yield conn
    finally:
        conn.close()


def _to_dict(row: dict) -> dict:
    result = dict(row)
    for k, v in result.items():
        if isinstance(v, Decimal):
            result[k] = float(v)
    return result


def list_users() -> list[dict[str, Any]]:
    """Return all rows that have a user_id (the demo users)."""
    try:
        with _get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    f"SELECT user_id, full_name, email, credit_card_number "
                    f"FROM {TABLE} WHERE user_id IS NOT NULL "
                    f"ORDER BY user_id"
                )
                return [_to_dict(row) for row in cur.fetchall()]
    except Exception:
        logger.exception("Failed to list users")
        return []


def get_profile(user_id: str) -> dict[str, Any] | None:
    """Read a user profile from customer_features."""
    try:
        with _get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    f"SELECT * FROM {TABLE} WHERE user_id = %s",
                    (user_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                return _to_dict(row)
    except Exception:
        logger.exception("Failed to read profile from Postgres")
        return None


def update_profile(user_id: str, data: dict[str, Any]) -> bool:
    """Update editable profile fields in customer_features for the given user."""
    profile_fields = [
        "full_name",
        "email",
        "phone",
        "country_of_residence",
        "preferred_currency",
        "allow_international_transactions",
        "daily_limit",
        "enable_notifications",
        "two_factor_enabled",
    ]

    updates = []
    values: list[Any] = []
    for field in profile_fields:
        if field in data:
            updates.append(f"{field} = %s")
            values.append(data[field])

    if not updates:
        return False

    values.append(user_id)
    set_clause = ", ".join(updates)

    try:
        with _get_conn() as conn:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    f"UPDATE {TABLE} SET {set_clause} WHERE user_id = %s",
                    values,
                )
                return cur.rowcount > 0
    except Exception:
        logger.exception("Failed to update profile")
        return False
