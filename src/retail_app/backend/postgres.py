from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from decimal import Decimal
from typing import Any

import psycopg2
import psycopg2.extras

logger = logging.getLogger("retail-app.postgres")

PG_HOST = os.getenv(
    "PG_HOST",
    "instance-7ede3904-e0b9-47af-9fa1-6d66235de644.database.azuredatabricks.net",
)
PG_PORT = int(os.getenv("PG_PORT", "5432"))
PG_DB = os.getenv("PG_DB", "custom")
PG_USER = os.getenv("PG_USER", "integration_role")
PG_PASSWORD = os.getenv("PG_PASSWORD", "IntegrationPassword@00")

PROFILE_TABLE = "banking.user_profiles"


@contextmanager
def _get_conn():
    conn = psycopg2.connect(
        host=PG_HOST,
        port=PG_PORT,
        dbname=PG_DB,
        user=PG_USER,
        password=PG_PASSWORD,
        sslmode="require",
        connect_timeout=10,
    )
    try:
        yield conn
    finally:
        conn.close()


def get_profile(user_id: str = "usr-001") -> dict[str, Any] | None:
    """Read a user profile from Postgres. Returns None if not found."""
    try:
        with _get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    f"SELECT * FROM {PROFILE_TABLE} WHERE user_id = %s",
                    (user_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                result = dict(row)
                for k, v in result.items():
                    if isinstance(v, Decimal):
                        result[k] = float(v)
                return result
    except Exception:
        logger.exception("Failed to read profile from Postgres")
        return None
