"""
Credit Card Fraud Detection Model with Lakebase Feature Lookup

MLflow code-based model with:
- OAuthTokenManager: Background token refresh for sp_blog service principal
- LakebaseConnectionPool: Pre-warmed psycopg2 connection pool with auto-rebuild
- FraudDetectionModel: CatBoost inference with real-time Lakebase feature lookup
"""

import os
import re
import time
import threading
from datetime import datetime, timedelta
from typing import Optional, Tuple, Any

import requests
import numpy as np
import pandas as pd
import psycopg2
from psycopg2 import pool
import cloudpickle
import mlflow


class OAuthTokenManager:
    """Manages OAuth token lifecycle with automatic background refresh."""

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        token_url: str,
        refresh_margin_seconds: int = 300,
        enable_background_refresh: bool = True,
    ):
        self.client_id = client_id
        self.client_secret = client_secret
        self.token_url = token_url
        self.refresh_margin_seconds = refresh_margin_seconds

        self._token: Optional[str] = None
        self._expiry: Optional[datetime] = None
        self._lock = threading.Lock()
        self._shutdown = threading.Event()
        self._refresh_thread: Optional[threading.Thread] = None

        self._refresh_token()

        if enable_background_refresh:
            self._start_refresh_thread()

    def _fetch_new_token(self) -> Tuple[str, datetime]:
        data = {
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "scope": "all-apis",
        }
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        resp = requests.post(self.token_url, data=data, headers=headers, timeout=10)
        resp.raise_for_status()
        token_data = resp.json()
        token = token_data["access_token"]
        expires_in = token_data.get("expires_in", 3600)
        expiry = datetime.utcnow() + timedelta(seconds=expires_in)
        return token, expiry

    def _refresh_token(self) -> None:
        token, expiry = self._fetch_new_token()
        with self._lock:
            self._token = token
            self._expiry = expiry
            print(f"[{datetime.utcnow().isoformat()}] Token refreshed. Expires at: {expiry.isoformat()}")

    def _refresh_loop(self) -> None:
        while not self._shutdown.is_set():
            with self._lock:
                expiry = self._expiry
            if expiry:
                time_until_refresh = (
                    expiry - datetime.utcnow() - timedelta(seconds=self.refresh_margin_seconds)
                ).total_seconds()
                if time_until_refresh <= 0:
                    try:
                        self._refresh_token()
                    except Exception as e:
                        print(f"[{datetime.utcnow().isoformat()}] Token refresh error: {e}")
                        time_until_refresh = 30
                sleep_time = min(max(time_until_refresh, 1), 60)
                self._shutdown.wait(timeout=sleep_time)
            else:
                self._shutdown.wait(timeout=60)

    def _start_refresh_thread(self) -> None:
        self._refresh_thread = threading.Thread(
            target=self._refresh_loop, daemon=True, name="OAuthTokenRefreshThread"
        )
        self._refresh_thread.start()

    def get_token(self) -> str:
        with self._lock:
            return self._token

    def get_expiry(self) -> Optional[datetime]:
        with self._lock:
            return self._expiry

    def get_status(self) -> dict:
        with self._lock:
            seconds_until_expiry = None
            if self._expiry:
                seconds_until_expiry = (self._expiry - datetime.utcnow()).total_seconds()
            return {
                "token_expiry": self._expiry.isoformat() if self._expiry else None,
                "seconds_until_expiry": seconds_until_expiry,
                "seconds_until_refresh": (
                    seconds_until_expiry - self.refresh_margin_seconds
                    if seconds_until_expiry
                    else None
                ),
                "refresh_thread_alive": (
                    self._refresh_thread.is_alive() if self._refresh_thread else False
                ),
            }

    def shutdown(self) -> None:
        self._shutdown.set()
        if self._refresh_thread:
            self._refresh_thread.join(timeout=5)


class LakebaseConnectionPool:
    """psycopg2 ThreadedConnectionPool with automatic rebuild on token refresh."""

    def __init__(
        self,
        host: str,
        dbname: str,
        token_manager: OAuthTokenManager,
        minconn: int = 3,
        maxconn: int = 10,
        port: str = "5432",
        connect_timeout: int = 10,
    ):
        self.host = host
        self.dbname = dbname
        self.token_manager = token_manager
        self.minconn = minconn
        self.maxconn = maxconn
        self.port = port
        self.connect_timeout = connect_timeout

        self._pool: Optional[pool.ThreadedConnectionPool] = None
        self._pool_lock = threading.Lock()
        self._pool_token: Optional[str] = None

        self._create_pool()

    def _create_pool(self) -> None:
        current_token = self.token_manager.get_token()
        new_pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=self.minconn,
            maxconn=self.maxconn,
            host=self.host,
            dbname=self.dbname,
            user=self.token_manager.client_id,
            password=current_token,
            sslmode="require",
            port=self.port,
            connect_timeout=self.connect_timeout,
        )
        with self._pool_lock:
            old_pool = self._pool
            self._pool = new_pool
            self._pool_token = current_token
            print(f"[{datetime.utcnow().isoformat()}] Connection pool created with {self.minconn} warm connections")
        if old_pool:
            threading.Timer(30.0, self._close_pool, args=[old_pool]).start()

    def _close_pool(self, pool_to_close: pool.ThreadedConnectionPool) -> None:
        try:
            pool_to_close.closeall()
        except Exception as e:
            print(f"[{datetime.utcnow().isoformat()}] Error closing pool: {e}")

    def _ensure_pool_valid(self) -> None:
        current_token = self.token_manager.get_token()
        with self._pool_lock:
            needs_rebuild = self._pool_token != current_token
        if needs_rebuild:
            self._create_pool()

    def getconn(self) -> Any:
        self._ensure_pool_valid()
        with self._pool_lock:
            return self._pool.getconn()

    def putconn(self, conn: Any) -> None:
        with self._pool_lock:
            if self._pool:
                self._pool.putconn(conn)

    def execute_query(self, query: str, params: tuple = None) -> pd.DataFrame:
        conn = self.getconn()
        try:
            return pd.read_sql(query, conn, params=params)
        finally:
            self.putconn(conn)

    def shutdown(self) -> None:
        with self._pool_lock:
            if self._pool:
                self._pool.closeall()
                self._pool = None


class FraudDetectionModel(mlflow.pyfunc.PythonModel):
    """
    CatBoost fraud detection with real-time Lakebase feature lookup.

    Input columns: user, country, country_code, amount, credit_card, currency
    Output columns: fraud_probability, fraud_flag, card_bin, lookup_ms, inference_ms, total_ms, error
    """

    FEATURE_COLS = [
        "avg_transaction_amount",
        "daily_transaction_count",
        "cross_border_ratio",
        "high_risk_merchant_ratio",
        "chargeback_rate",
        "avg_fraud_score_30d",
        "velocity_24h",
        "is_corporate_card",
        "risk_tier",
        "amount",
        "amount_to_avg_ratio",
        "is_cross_border",
    ]

    def load_context(self, context) -> None:
        model_path = context.artifacts["model_pickle"]
        with open(model_path, "rb") as f:
            self.model = cloudpickle.load(f)

        client_id = os.environ["CLIENT_ID"]
        client_secret = os.environ["CLIENT_SECRET"]
        token_url = os.environ["OIDC_TOKEN_URL"]
        db_host = os.environ["DB_HOST"]
        db_name = os.environ["DB_NAME"]
        db_port = os.environ.get("DB_PORT", "5432")

        self.token_manager = OAuthTokenManager(
            client_id=client_id,
            client_secret=client_secret,
            token_url=token_url,
            refresh_margin_seconds=300,
            enable_background_refresh=True,
        )
        self.conn_pool = LakebaseConnectionPool(
            host=db_host,
            dbname=db_name,
            token_manager=self.token_manager,
            minconn=3,
            maxconn=10,
        )
        print(f"[{datetime.utcnow().isoformat()}] FraudDetectionModel loaded successfully")

    @staticmethod
    def _extract_card_bin(credit_card: str) -> str:
        digits = re.sub(r"\D", "", str(credit_card))
        return digits[:6]

    def _lookup_customer_features(self, card_bin: str) -> Optional[dict]:
        df = self.conn_pool.execute_query(
            "SELECT * FROM customer_features WHERE card_bin = %s LIMIT 1",
            params=(card_bin,),
        )
        if df.empty:
            return None
        return df.iloc[0].to_dict()

    def predict(self, context, model_input: pd.DataFrame) -> pd.DataFrame:
        results = []
        for _, row in model_input.iterrows():
            t_start = time.perf_counter()
            try:
                card_bin = self._extract_card_bin(row["credit_card"])

                t_lookup_start = time.perf_counter()
                features = self._lookup_customer_features(card_bin)
                lookup_ms = (time.perf_counter() - t_lookup_start) * 1000

                if features is None:
                    total_ms = (time.perf_counter() - t_start) * 1000
                    results.append(
                        {
                            "fraud_probability": None,
                            "fraud_flag": None,
                            "card_bin": card_bin,
                            "lookup_ms": lookup_ms,
                            "inference_ms": None,
                            "total_ms": total_ms,
                            "error": "BIN_NOT_FOUND",
                        }
                    )
                    continue

                amount = float(row["amount"])
                avg_txn = float(features.get("avg_transaction_amount", 0))
                amount_to_avg_ratio = amount / max(avg_txn, 0.01)
                is_cross_border = 1 if row["country_code"] != features.get("country_of_residence") else 0

                feature_vector = np.array(
                    [
                        avg_txn,
                        float(features.get("daily_transaction_count", 0)),
                        float(features.get("cross_border_ratio", 0)),
                        float(features.get("high_risk_merchant_ratio", 0)),
                        float(features.get("chargeback_rate", 0)),
                        float(features.get("avg_fraud_score_30d", 0)),
                        float(features.get("velocity_24h", 0)),
                        float(features.get("is_corporate_card", 0)),
                        float(features.get("risk_tier", 1)),
                        amount,
                        amount_to_avg_ratio,
                        float(is_cross_border),
                    ]
                ).reshape(1, -1)

                t_infer_start = time.perf_counter()
                fraud_prob = float(self.model.predict_proba(feature_vector)[0, 1])
                inference_ms = (time.perf_counter() - t_infer_start) * 1000

                total_ms = (time.perf_counter() - t_start) * 1000
                results.append(
                    {
                        "fraud_probability": fraud_prob,
                        "fraud_flag": 1 if fraud_prob >= 0.15 else 0,
                        "card_bin": card_bin,
                        "lookup_ms": lookup_ms,
                        "inference_ms": inference_ms,
                        "total_ms": total_ms,
                        "error": None,
                    }
                )
            except Exception as e:
                total_ms = (time.perf_counter() - t_start) * 1000
                results.append(
                    {
                        "fraud_probability": None,
                        "fraud_flag": None,
                        "card_bin": None,
                        "lookup_ms": None,
                        "inference_ms": None,
                        "total_ms": total_ms,
                        "error": str(e),
                    }
                )

        return pd.DataFrame(results)


mlflow.models.set_model(FraudDetectionModel())
