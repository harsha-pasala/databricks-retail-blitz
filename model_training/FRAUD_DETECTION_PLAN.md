# Credit Card Fraud Detection — Build Plan

**Platform:** Databricks  
**Workspace Profile:** `fevm`  
**Service Principal:** `sp_blog`  
**Unity Catalog:** `tko2026.tko`  
**Online Feature Store:** Lakebase Autoscaling (existing instance)  
**Endpoint Type:** Route-Optimized Model Serving  

---

## Architecture Overview

```
Incoming Payload
  { user, country, country_code, amount, credit_card, currency }
         │
         ▼
Model Serving Endpoint (route-optimized, scale_to_zero=False)
         │
         ├─► _extract_card_bin(credit_card) → "670539"
         │
         ├─► Lakebase PostgreSQL Feature Lookup
         │     SELECT * FROM customer_features WHERE card_bin = %s
         │     (via LakebaseConnectionPool with pre-warmed connections)
         │
         ├─► Derive transaction features
         │     amount_to_avg_ratio, is_cross_border
         │
         └─► CatBoost inference → fraud_probability, fraud_flag, latency breakdown
```

---

## Workspace & Credentials

| Parameter | Value |
|---|---|
| Workspace profile | `fevm` |
| Service principal | `sp_blog` |
| CLIENT_ID secret | `dbutils.secrets.get(scope="sp_blog", key="client_id")` |
| CLIENT_SECRET secret | `dbutils.secrets.get(scope="sp_blog", key="client_secret")` |
| OIDC token URL | `https://<workspace_host>/oidc/v1/token` |
| Unity Catalog | `tko2026` |
| Schema | `tko` |
| Registered model name | `tko2026.tko.credit_card_fraud_model` |

---

## Lakebase Connection (Existing Instance — Do NOT Provision)

```python
DB_HOST = "ep-crimson-meadow-e1ckeiiu.database.eastus2.azuredatabricks.net"
DB_NAME = "databricks_postgres"
DB_PORT = "5432"
```

---

## Deliverables

| File | Purpose |
|---|---|
| `fraud_detection_notebook.py` | Databricks notebook (all 7 steps) |
| `fraud_model.py` | MLflow code-based model (3 classes + `set_model`) |

---

## Step 1 — Synthetic Data Generation

### Customer Feature Table (`customer_features`)
Primary key: `card_bin` STRING — first 6 digits of credit card number (e.g., `"670539"`)

| Column | Type | Description |
|---|---|---|
| `card_bin` | STRING | 6-digit BIN, **PRIMARY KEY** |
| `card_network` | STRING | Visa / Mastercard / Amex / Discover / UnionPay |
| `issuing_country` | STRING | 2-letter ISO country code |
| `avg_transaction_amount` | DOUBLE | Average historical transaction amount for this BIN |
| `daily_transaction_count` | INTEGER | Average daily transactions in last 30 days |
| `cross_border_ratio` | DOUBLE | Ratio of cross-border transactions (0.0–1.0) |
| `high_risk_merchant_ratio` | DOUBLE | Ratio of high-risk MCC transactions (0.0–1.0) |
| `chargeback_rate` | DOUBLE | Historical chargeback rate (0.0–0.05) |
| `avg_fraud_score_30d` | DOUBLE | Rolling 30-day average fraud score (0.0–1.0) |
| `velocity_24h` | INTEGER | Number of transactions in last 24h window |
| `is_corporate_card` | INTEGER | 0 or 1 |
| `risk_tier` | INTEGER | 1 = low, 2 = medium, 3 = high |

**Volume:** 50,000 synthetic customers

**Fraud label hints for synthetic generation:**
- Higher `chargeback_rate` + `high_risk_merchant_ratio` → higher fraud probability
- `velocity_24h > 20` → higher risk
- `cross_border_ratio > 0.7` → higher risk
- Base fraud rates: tier 3 = 15%, tier 2 = 4%, tier 1 = 0.8%

### Transaction Table

| Column | Type |
|---|---|
| `transaction_id` | STRING (UUID) |
| `card_bin` | STRING (FK) |
| `user` | STRING |
| `country` | STRING |
| `country_code` | STRING |
| `amount` | DOUBLE |
| `currency` | STRING |
| `is_fraud` | INTEGER |

**Volume:** 200,000 synthetic transactions

---

## Step 2 — Populate Lakebase Feature Table

### 2a. Create Table (if not exists)

```sql
CREATE TABLE IF NOT EXISTS customer_features (
    card_bin            VARCHAR(6) PRIMARY KEY,
    card_network        VARCHAR(20),
    issuing_country     CHAR(2),
    avg_transaction_amount   DOUBLE PRECISION,
    daily_transaction_count  INTEGER,
    cross_border_ratio       DOUBLE PRECISION,
    high_risk_merchant_ratio DOUBLE PRECISION,
    chargeback_rate          DOUBLE PRECISION,
    avg_fraud_score_30d      DOUBLE PRECISION,
    velocity_24h             INTEGER,
    is_corporate_card        SMALLINT,
    risk_tier                SMALLINT
);
CREATE INDEX IF NOT EXISTS idx_customer_features_card_bin
    ON customer_features(card_bin);
```

### 2b. Bulk Insert (Idempotent Upsert)

Use `psycopg2.extras.execute_values` with `INSERT ... ON CONFLICT (card_bin) DO UPDATE SET ...` for all 50,000 rows.  
Authenticate using an OAuth token obtained from the sp_blog service principal via the OIDC endpoint.

---

## Step 3 — Model Training

### 3a. Training Feature Set

Join 200,000 transactions with `customer_features` on `card_bin`, then add:

| Derived Feature | Formula |
|---|---|
| `amount_to_avg_ratio` | `amount / max(avg_transaction_amount, 0.01)` |
| `is_cross_border` | `1 if country_code != issuing_country else 0` |

**Final feature columns (12 total):**
```
avg_transaction_amount, daily_transaction_count, cross_border_ratio,
high_risk_merchant_ratio, chargeback_rate, avg_fraud_score_30d,
velocity_24h, is_corporate_card, risk_tier,
amount, amount_to_avg_ratio, is_cross_border
```

**Label:** `is_fraud`

### 3b. CatBoost Classifier

```python
CatBoostClassifier(
    iterations=300,
    learning_rate=0.05,
    depth=6,
    eval_metric='AUC',
    verbose=50,
    random_seed=42
)
```

- 80/20 train/test split
- Report: ROC AUC, Precision, Recall, F1 at threshold 0.5

### 3c. Save Artifact

```python
with open("artifacts/fraud_catboost_model.pkl", "wb") as f:
    cloudpickle.dump(model, f)
```

---

## Step 4 — Companion File: `fraud_model.py`

This file is used for **MLflow code-based logging** (path string passed to `log_model`, not the object).  
It must end with `mlflow.models.set_model(FraudDetectionModel())`.

### Class 1: `OAuthTokenManager`

**Purpose:** Manage OAuth token lifecycle with automatic background refresh for the sp_blog service principal.

```
__init__(client_id, client_secret, token_url,
         refresh_margin_seconds=300, enable_background_refresh=True)
  ├── _refresh_token()          ← called immediately on init
  └── _start_refresh_thread()  ← daemon thread "OAuthTokenRefreshThread"

_fetch_new_token()
  └── POST to token_url
        grant_type=client_credentials, scope=all-apis
      returns (access_token, expiry_datetime)

_refresh_loop()
  └── while not _shutdown:
        time_until_refresh = (expiry - utcnow - margin).total_seconds()
        if <= 0: _refresh_token()
        sleep = min(max(time_until_refresh, 1), 60)
        _shutdown.wait(timeout=sleep)

get_token()     → thread-safe (uses threading.Lock)
get_expiry()    → thread-safe
get_status()    → dict: expiry, seconds_until_expiry, seconds_until_refresh, thread_alive
shutdown()      → set event, join thread (timeout=5s)
```

### Class 2: `LakebaseConnectionPool`

**Purpose:** `psycopg2.pool.ThreadedConnectionPool` with automatic pool rebuild when the OAuth token refreshes.

```
__init__(host, dbname, token_manager,
         minconn=3, maxconn=10, port='5432', connect_timeout=10)
  └── _create_pool()  ← called immediately

_create_pool()
  ├── ThreadedConnectionPool(
  │     user=client_id, password=current_token,
  │     sslmode="require", connect_timeout=connect_timeout
  │   )
  ├── swap new pool under _pool_lock
  └── if old pool: threading.Timer(30.0, _close_pool, [old_pool]).start()

_ensure_pool_valid()
  └── if _pool_token != token_manager.get_token(): _create_pool()

getconn()                 → _ensure_pool_valid(), then _pool.getconn()
putconn(conn)             → _pool.putconn(conn)
execute_query(query, params=None)
  └── conn = getconn()
      try: pd.read_sql(query, conn, params=params)
      finally: putconn(conn)
shutdown()                → closeall() under lock
```

### Class 3: `FraudDetectionModel(mlflow.pyfunc.PythonModel)`

```python
FEATURE_COLS = [
    "avg_transaction_amount", "daily_transaction_count", "cross_border_ratio",
    "high_risk_merchant_ratio", "chargeback_rate", "avg_fraud_score_30d",
    "velocity_24h", "is_corporate_card", "risk_tier",
    "amount", "amount_to_avg_ratio", "is_cross_border"
]

load_context(context)
  ├── Load CatBoost model from context.artifacts["model_pickle"]
  ├── Read from os.environ:
  │     CLIENT_ID, CLIENT_SECRET, OIDC_TOKEN_URL, DB_HOST, DB_NAME, DB_PORT
  ├── Init OAuthTokenManager(client_id, client_secret, token_url,
  │                          refresh_margin_seconds=300, enable_background_refresh=True)
  └── Init LakebaseConnectionPool(host, dbname, token_manager, minconn=3, maxconn=10)

_extract_card_bin(credit_card: str) → str
  └── strip all non-digit chars, return first 6 digits

_lookup_customer_features(card_bin: str) → dict | None
  └── execute_query(
        "SELECT * FROM customer_features WHERE card_bin = %s LIMIT 1",
        params=(card_bin,)
      )
      return first row as dict, or None if empty

predict(context, model_input: pd.DataFrame) → pd.DataFrame
  # model_input columns: user, country, country_code, amount, credit_card, currency
  for each row:
    1. _extract_card_bin(credit_card)
    2. _lookup_customer_features(card_bin)  → measure lookup_ms
    3. if not found: return BIN_NOT_FOUND row
    4. amount_to_avg_ratio = amount / max(avg_transaction_amount, 0.01)
    5. is_cross_border = 1 if country_code != issuing_country else 0
    6. build feature vector, CatBoost inference  → measure inference_ms
    7. return fraud_probability, fraud_flag, card_bin, lookup_ms, inference_ms, total_ms, error
```

**Output schema per row:**

| Field | Type | Notes |
|---|---|---|
| `fraud_probability` | DOUBLE | 0.0–1.0 |
| `fraud_flag` | INTEGER | 1 if probability ≥ 0.5 |
| `card_bin` | STRING | Extracted from input |
| `lookup_ms` | DOUBLE | Lakebase query latency |
| `inference_ms` | DOUBLE | CatBoost inference latency |
| `total_ms` | DOUBLE | Total predict() latency |
| `error` | STRING / None | `"BIN_NOT_FOUND"` or `None` |

**Last line of `fraud_model.py`:**
```python
mlflow.models.set_model(FraudDetectionModel())
```

---

## Step 5 — Log and Register Model

```python
mlflow.set_registry_uri("databricks-uc")

# Resolve fraud_model.py path (same directory as notebook)
notebook_dir = "/Workspace" + os.path.dirname(notebook_path)
model_code_path = os.path.join(notebook_dir, "fraud_model.py")

with mlflow.start_run(run_name="fraud_detection_lakebase_v1"):
    model_info = mlflow.pyfunc.log_model(
        artifact_path="fraud_model",
        python_model=model_code_path,          # string path — NOT object instance
        artifacts={"model_pickle": "artifacts/fraud_catboost_model.pkl"},
        registered_model_name="tko2026.tko.credit_card_fraud_model",
        input_example=input_example,
        signature=mlflow.models.infer_signature(input_example, output_example),
        pip_requirements=[
            "catboost==1.2.8",
            "cloudpickle==2.2.1",
            "psycopg2-binary==2.9.9",
            "pandas>=1.5.3",
            "numpy>=1.23.5",
            "requests>=2.28.0",
            "mlflow>=2.12.0",
        ]
    )
```

**Input example payload:**
```json
{
  "user": "usr_abc123",
  "country": "Germany",
  "country_code": "DE",
  "amount": 500.0,
  "credit_card": "6705 3964 7662 5875",
  "currency": "USD"
}
```

---

## Step 6 — Deploy Route-Optimized Endpoint

```python
from databricks.sdk.service.serving import (
    ServedModelInput, EndpointCoreConfigInput, ServedModelInputWorkloadType
)

ENDPOINT_NAME = "fraud-detection-lakebase"

served_model = ServedModelInput(
    model_name="tko2026.tko.credit_card_fraud_model",
    model_version=model_info.registered_model_version,
    workload_type=ServedModelInputWorkloadType.CPU,
    workload_size="Small",
    scale_to_zero_enabled=False,   # keep warm — no cold starts
    environment_vars={
        "CLIENT_ID":      "{{secrets/sp_blog/client_id}}",
        "CLIENT_SECRET":  "{{secrets/sp_blog/client_secret}}",
        "OIDC_TOKEN_URL": "<oidc_token_url>",
        "DB_HOST":        "ep-crimson-meadow-e1ckeiiu.database.eastus2.azuredatabricks.net",
        "DB_NAME":        "databricks_postgres",
        "DB_PORT":        "5432",
    }
)
```

**Create or update logic:**
```python
try:
    w.serving_endpoints.get(name=ENDPOINT_NAME)
    # Exists → update config (route_optimized cannot change post-creation)
    w.serving_endpoints.update_config(name=ENDPOINT_NAME, served_models=[served_model]).result()
except ResourceDoesNotExist:
    # Does not exist → create with route_optimized=True
    w.serving_endpoints.create(
        name=ENDPOINT_NAME,
        config=config,
        route_optimized=True
    ).result()
```

---

## Step 7 — Test Endpoint via SDK Data Plane API

> **Important:** For route-optimized endpoints, do NOT use `requests.post`. Use `serving_endpoints_data_plane.query()`.

### Build SP-authenticated client

```python
import databricks.sdk.core as sdk_core

sp_config = sdk_core.Config(
    host=f"https://{workspace_host}",
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET
)
sp_client = WorkspaceClient(config=sp_config)
```

### Smoke test

```python
response = sp_client.serving_endpoints_data_plane.query(
    name=ENDPOINT_NAME,
    dataframe_records=[{
        "user": "usr_abc123",
        "country": "Germany",
        "country_code": "DE",
        "amount": 500.0,
        "credit_card": "6705 3964 7662 5875",
        "currency": "USD"
    }]
)
```

**Expected response shape:**
```json
{
  "predictions": [{
    "fraud_probability": 0.0312,
    "fraud_flag": 0,
    "card_bin": "670539",
    "lookup_ms": 3.5,
    "inference_ms": 1.2,
    "total_ms": 4.9,
    "error": null
  }]
}
```

### Latency Benchmark (`measure_latency_sdk`)

```
warmup_requests=5, num_requests=50, delay=0.1s  → single record benchmark
warmup_requests=3, num_requests=100, delay=0s   → burst test
```

Reported metrics: min, max, mean, median, p50, p90, p95, p99 (all in ms)

---

## Critical Implementation Constraints

| # | Constraint |
|---|---|
| 1 | `fraud_model.py` **must end** with `mlflow.models.set_model(FraudDetectionModel())` |
| 2 | Code-based logging: pass `python_model=<path_string>`, NOT `python_model=FraudDetectionModel()` — avoids pickling background threads |
| 3 | `load_context` initializes token manager and pool; `predict` only uses pre-warmed connections |
| 4 | All shared state uses `threading.Lock()`; old pool closed after 30s via `threading.Timer` |
| 5 | Secrets injected as env vars using `"{{secrets/scope/key}}"` syntax (double curly braces) |
| 6 | Endpoint created with `route_optimized=True`; use `update_config()` for updates (cannot re-set `route_optimized`) |
| 7 | Test via `serving_endpoints_data_plane.query()` — NOT `requests.post` |
| 8 | `mlflow.set_registry_uri("databricks-uc")` before any `log_model` call |
| 9 | `scale_to_zero_enabled=False` on the served model |
| 10 | BIN extraction: strip all non-digit chars from `credit_card`, take first 6 digits |

---

## pip Requirements

```
catboost==1.2.8
cloudpickle==2.2.1
psycopg2-binary==2.9.9
pandas>=1.5.3
numpy>=1.23.5
requests>=2.28.0
mlflow>=2.12.0
databricks-sdk>=0.28.0
```

---

## Reference Files

| File | Key Patterns Used |
|---|---|
| `Notebook/lakebase_model.py` | `OAuthTokenManager`, `LakebaseConnectionPool`, `mlflow.models.set_model()`, code-based logging |
| `Notebook/model.py` | Route-optimized endpoint creation, `serving_endpoints_data_plane.query()`, SP client config, latency benchmarking |
| `Notebook/Benchmarking Demo for Nuvei v2.py` | `FraudDetectorTimed` pyfunc pattern, UC model registration, `ServedModelInput`, endpoint create/update |
