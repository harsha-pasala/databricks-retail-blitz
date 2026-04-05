# Credit Card Fraud Detection — Implementation Plan

**Platform:** Databricks
**Workspace Profile:** `fevm`
**Service Principal:** `sp_blog`
**Unity Catalog:** `tko2026.tko`
**Online Feature Store:** Lakebase (PostgreSQL)
**Endpoint Type:** Route-Optimized Model Serving
**App URL:** `https://retail-app-7405612444656138.18.azure.databricksapps.com`

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React 19)                          │
│  Profile Page                          Transaction Page             │
│  ┌──────────────┐                     ┌──────────────────┐          │
│  │ User Dropdown │ ←── GET /api/users │ World Map        │          │
│  │ Edit Profile  │                    │ Amount Slider    │          │
│  │ Save to DB    │                    │ Card (read-only) │          │
│  └──────┬───────┘                     └────────┬─────────┘          │
│         │ POST /api/profile                    │ POST /api/transactions
└─────────┼──────────────────────────────────────┼────────────────────┘
          │                                      │
          ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      BACKEND (FastAPI)                               │
│                                                                      │
│  POST /api/profile                POST /api/transactions             │
│  ┌──────────────┐                ┌───────────────────────────┐       │
│  │ Direct write  │                │ 1. Call Fraud Model       │       │
│  │ to Postgres   │                │ 2. Check Business Rules   │       │
│  └──────┬───────┘                │    - daily_limit          │       │
│         │                        │    - allow_international   │       │
│         │                        │ 3. Return result + latency│       │
│         │                        └────────────┬──────────────┘       │
└─────────┼─────────────────────────────────────┼─────────────────────┘
          │                                      │
          ▼                                      ▼
┌─────────────────────┐        ┌──────────────────────────────────────┐
│   Lakebase           │        │  Model Serving Endpoint              │
│   (PostgreSQL)       │        │  (route-optimized, CPU, Small)       │
│                      │        │                                      │
│  customer_features   │◄───────│  1. Extract card BIN (first 6 digits)│
│  ┌────────────────┐  │        │  2. Lookup features from Lakebase    │
│  │ card_bin (PK)   │  │        │  3. Derive: amount_to_avg_ratio,    │
│  │ risk_tier       │  │        │     is_cross_border                 │
│  │ chargeback_rate │  │        │  4. CatBoost inference               │
│  │ velocity_24h    │  │        │  5. Return fraud_prob, flag, latency │
│  │ user_id         │  │        └──────────────────────────────────────┘
│  │ full_name       │  │
│  │ daily_limit     │  │
│  │ allow_intl_txn  │  │
│  │ ...             │  │
│  └────────────────┘  │
└─────────────────────┘
```

### Transaction Decision Flow

```
Transaction Request
       │
       ▼
┌──────────────────────┐
│  1. FRAUD MODEL      │  Always called first (for latency telemetry)
│  CatBoost inference  │
│  on 12 features      │
└──────────┬───────────┘
           │
           ▼
    fraud_prob >= 0.15? ──YES──► DECLINED (Fraud detected)
           │                         + latency breakdown
           NO
           │
           ▼
┌──────────────────────┐
│  2. BUSINESS RULES   │  Checked against user profile in Postgres
│  (from Postgres)     │
└──────────┬───────────┘
           │
     amount > daily_limit? ──YES──► DECLINED (Over limit)
           │                             + latency breakdown
           NO
           │
     is_cross_border AND    ──YES──► DECLINED (Intl disabled)
     !allow_international?               + latency breakdown
           │
           NO
           │
           ▼
       APPROVED
       + latency breakdown
```

---

## Workspace & Credentials

| Parameter | Value |
|---|---|
| Workspace host | `adb-7405612444656138.18.azuredatabricks.net` |
| Workspace profile | `fevm` |
| Service principal scope | `sp_blog` |
| CLIENT_ID secret | `dbutils.secrets.get(scope="sp_blog", key="client_id")` |
| CLIENT_SECRET secret | `dbutils.secrets.get(scope="sp_blog", key="client_secret")` |
| OIDC token URL | `https://adb-7405612444656138.18.azuredatabricks.net/oidc/v1/token` |
| Unity Catalog | `tko2026` |
| Schema | `tko` |
| Registered model name | `tko2026.tko.credit_card_fraud_model` |

---

## Lakebase Connection

```python
DB_HOST = "ep-crimson-meadow-e1ckeiiu.database.eastus2.azuredatabricks.net"
DB_NAME = "databricks_postgres"
DB_PORT = "5432"
```

**Auth:** OAuth token via SP credentials (client_credentials grant). The app loads credentials from env vars or falls back to Databricks SDK secrets API.

---

## Deliverables

| File | Purpose |
|---|---|
| `model_training/fraud_detection_notebook.py` | Databricks notebook — data gen, Lakebase population, model training, deployment (7 steps) |
| `model_training/fraud_model.py` | MLflow code-based model — OAuth, connection pool, CatBoost inference |
| `src/retail_app/backend/router.py` | FastAPI routes — transactions (model + business rules), profile CRUD, user list |
| `src/retail_app/backend/postgres.py` | Lakebase client — OAuth token caching, read/write customer_features |
| `src/retail_app/backend/models.py` | Pydantic schemas — TransactionIn/Out, UserProfile, UserSummary |
| `src/retail_app/ui/routes/index.tsx` | Transaction page — map, amount slider, read-only card, card tap animation |
| `src/retail_app/ui/routes/profile.tsx` | Profile page — user dropdown, settings, direct Postgres save |
| `src/retail_app/ui/components/CardTapAnimation.tsx` | Animated card tap with approve/decline + latency waterfall |
| `src/retail_app/ui/components/WorldMap.tsx` | Interactive world map with alpha-2 country codes |
| `src/retail_app/ui/lib/UserContext.tsx` | Global user state (persisted to localStorage) |
| `app.yml` | Databricks App config — uvicorn command, env vars for Lakebase |
| `databricks.yml` | Bundle config — deploy to `fevm` workspace |

---

## Step 1 — Synthetic Data Generation

### Customer Features Table (`customer_features`)

Single merged table serving as both **feature store** (for model inference) and **user profile store** (for the app).

Primary key: `card_bin` VARCHAR(6)

#### Model Features

| Column | Type | Description |
|---|---|---|
| `card_bin` | VARCHAR(6) | 6-digit BIN, **PRIMARY KEY** |
| `card_network` | VARCHAR(20) | Visa / Mastercard / Amex / Discover / UnionPay |
| `country_of_residence` | CHAR(2) | 2-letter ISO code (used for cross-border detection) |
| `avg_transaction_amount` | DOUBLE | Average historical transaction amount |
| `daily_transaction_count` | INTEGER | Average daily transactions (last 30 days) |
| `cross_border_ratio` | DOUBLE | Ratio of cross-border transactions (0.0–1.0) |
| `high_risk_merchant_ratio` | DOUBLE | Ratio of high-risk MCC transactions (0.0–1.0) |
| `chargeback_rate` | DOUBLE | Historical chargeback rate (0.0–0.05) |
| `avg_fraud_score_30d` | DOUBLE | Rolling 30-day average fraud score (0.0–1.0) |
| `velocity_24h` | INTEGER | Transactions in last 24h window |
| `is_corporate_card` | SMALLINT | 0 or 1 |
| `risk_tier` | SMALLINT | 1 = low, 2 = medium, 3 = high |

#### Profile Fields (merged into same table)

| Column | Type | Description |
|---|---|---|
| `credit_card_number` | VARCHAR(16) | Full 16-digit card number |
| `user_id` | VARCHAR(20) | User identifier (NULL for non-demo rows) |
| `full_name` | VARCHAR(100) | Display name |
| `email` | VARCHAR(100) | Email address |
| `phone` | VARCHAR(30) | Phone number |
| `preferred_currency` | VARCHAR(3) | USD, EUR, GBP, etc. |
| `allow_international_transactions` | BOOLEAN | Business rule: block cross-border if false |
| `daily_limit` | DOUBLE | Business rule: max transaction amount |
| `enable_notifications` | BOOLEAN | UI preference |
| `two_factor_enabled` | BOOLEAN | UI preference |

**Volume:** 50,000 rows total, 20 with full user profiles

**Risk tier distribution:** 60% tier 1, 30% tier 2, 10% tier 3
- Tier 3 features are skewed: high chargeback_rate (0.02–0.05), high velocity (15–40), high cross_border_ratio (0.5–0.9)
- Tier 2 features are moderately elevated
- 10 of the 20 demo users are forced to tier 3 (high-risk) for demo purposes

### 20 Demo Users

| User ID | Name | Country | Currency | Intl Txn | Daily Limit | Risk |
|---|---|---|---|---|---|---|
| usr-001 | John Doe | US | USD | Yes | $5,000 | **High** |
| usr-002 | Jane Smith | US | USD | Yes | $10,000 | Low |
| usr-003 | Akira Tanaka | JP | JPY | No | $3,000 | Low |
| usr-004 | Maria Garcia | ES | EUR | Yes | $7,500 | **High** |
| usr-005 | Hans Mueller | DE | EUR | Yes | $8,000 | **High** |
| usr-006 | Priya Sharma | IN | INR | No | $2,000 | Low |
| usr-007 | Sophie Laurent | FR | EUR | Yes | $6,000 | **High** |
| usr-008 | Lucas Silva | BR | BRL | Yes | $4,000 | **High** |
| usr-009 | Emma Wilson | GB | GBP | Yes | $9,000 | **High** |
| usr-010 | Wei Chen | CN | USD | No | $5,000 | Low |
| usr-011 | Olivia Brown | AU | AUD | Yes | $7,000 | Low |
| usr-012 | Carlos Hernandez | MX | MXN | Yes | $3,500 | **High** |
| usr-013 | Yuki Sato | JP | JPY | Yes | $6,000 | Low |
| usr-014 | Ahmed Al-Rashid | AE | USD | Yes | $15,000 | **High** |
| usr-015 | Anna Kowalski | DE | EUR | Yes | $4,500 | Low |
| usr-016 | David Kim | KR | USD | No | $5,000 | Low |
| usr-017 | Sarah Johnson | CA | CAD | Yes | $8,000 | **High** |
| usr-018 | Marco Rossi | IT | EUR | Yes | $5,500 | Low |
| usr-019 | Lin Zhang | SG | USD | Yes | $10,000 | **High** |
| usr-020 | Fatima Okafor | ZA | USD | Yes | $3,000 | Low |

### Transaction Table (`fraud_transactions`)

| Column | Type |
|---|---|
| `transaction_id` | STRING (UUID) |
| `card_bin` | STRING (FK) |
| `user` | STRING |
| `country` | STRING (display name) |
| `country_code` | STRING (2-letter ISO) |
| `amount` | DOUBLE |
| `currency` | STRING |
| `is_fraud` | INTEGER (0/1) |

**Volume:** 200,000 synthetic transactions

**Fraud label generation:**
- Base rates: tier 1 = 0.8%, tier 2 = 4%, tier 3 = 15%
- Boosted by: velocity > 20 (+5%), cross_border > 0.7 (+3%), chargeback > 0.03 (+4%), amount > $2000 (+3%)

---

## Step 2 — Populate Lakebase

### DDL

```sql
DROP TABLE IF EXISTS customer_features CASCADE;

CREATE TABLE customer_features (
    card_bin                 VARCHAR(6) PRIMARY KEY,
    card_network             VARCHAR(20),
    country_of_residence     CHAR(2),
    avg_transaction_amount   DOUBLE PRECISION,
    daily_transaction_count  INTEGER,
    cross_border_ratio       DOUBLE PRECISION,
    high_risk_merchant_ratio DOUBLE PRECISION,
    chargeback_rate          DOUBLE PRECISION,
    avg_fraud_score_30d      DOUBLE PRECISION,
    velocity_24h             INTEGER,
    is_corporate_card        SMALLINT,
    risk_tier                SMALLINT,
    credit_card_number       VARCHAR(16),
    user_id                  VARCHAR(20),
    full_name                VARCHAR(100),
    email                    VARCHAR(100),
    phone                    VARCHAR(30),
    preferred_currency       VARCHAR(3),
    allow_international_transactions BOOLEAN DEFAULT TRUE,
    daily_limit              DOUBLE PRECISION DEFAULT 5000,
    enable_notifications     BOOLEAN DEFAULT TRUE,
    two_factor_enabled       BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_customer_features_card_bin ON customer_features(card_bin);
CREATE INDEX idx_customer_features_user_id ON customer_features(user_id);
```

### Bulk Upsert

`psycopg2.extras.execute_values` with `INSERT ... ON CONFLICT (card_bin) DO UPDATE SET ...` for all 50,000 rows (batch size 5,000). Auth via OAuth token from SP.

---

## Step 3 — Model Training

### Feature Set (12 features)

Join `fraud_transactions` with `customer_features` on `card_bin`, then derive:

| Derived Feature | Formula |
|---|---|
| `amount_to_avg_ratio` | `amount / max(avg_transaction_amount, 0.01)` |
| `is_cross_border` | `1 if country_code != country_of_residence else 0` |

**Final feature columns:**
```
avg_transaction_amount, daily_transaction_count, cross_border_ratio,
high_risk_merchant_ratio, chargeback_rate, avg_fraud_score_30d,
velocity_24h, is_corporate_card, risk_tier,
amount, amount_to_avg_ratio, is_cross_border
```

**Label:** `is_fraud`

### CatBoost Classifier

```python
CatBoostClassifier(
    iterations=300, learning_rate=0.05, depth=6,
    eval_metric='AUC', verbose=50, random_seed=42
)
```

- 80/20 stratified train/test split
- Metrics: ROC AUC, Precision, Recall, F1
- Model saved to `artifacts/fraud_catboost_model.pkl` via cloudpickle

---

## Step 4 — `fraud_model.py` (MLflow PythonModel)

### Class 1: `OAuthTokenManager`

Manages SP OAuth token lifecycle with background refresh thread.

- `_fetch_new_token()` → POST to OIDC endpoint (client_credentials grant)
- `_refresh_loop()` → daemon thread, refreshes 300s before expiry
- `get_token()` → thread-safe via `threading.Lock`

### Class 2: `LakebaseConnectionPool`

`psycopg2.pool.ThreadedConnectionPool` with auto-rebuild on token refresh.

- `_create_pool()` → swaps pool under lock, closes old pool after 30s delay
- `_ensure_pool_valid()` → rebuilds if token changed
- `execute_query()` → returns `pd.DataFrame`

### Class 3: `FraudDetectionModel(mlflow.pyfunc.PythonModel)`

```python
load_context(context):
    # Load CatBoost model from artifacts
    # Init OAuthTokenManager + LakebaseConnectionPool

predict(context, model_input: pd.DataFrame) -> pd.DataFrame:
    for each row:
        1. Extract card BIN (first 6 digits)
        2. Lookup customer features from Lakebase (timed)
        3. If not found → return BIN_NOT_FOUND
        4. Derive: amount_to_avg_ratio, is_cross_border
        5. Build 12-element feature vector
        6. CatBoost predict_proba (timed)
        7. fraud_flag = 1 if fraud_probability >= 0.15

    Return: fraud_probability, fraud_flag, card_bin,
            lookup_ms, inference_ms, total_ms, error
```

**Last line:** `mlflow.models.set_model(FraudDetectionModel())`

---

## Step 5 — Log and Register Model

```python
mlflow.set_registry_uri("databricks-uc")

with mlflow.start_run(run_name="fraud_detection_lakebase_v2"):
    mlflow.pyfunc.log_model(
        artifact_path="fraud_model",
        python_model=model_code_path,       # string path, NOT object
        artifacts={"model_pickle": "artifacts/fraud_catboost_model.pkl"},
        registered_model_name="tko2026.tko.credit_card_fraud_model",
        input_example=input_example,
        signature=inferred_signature,
        pip_requirements=[...]
    )
```

---

## Step 6 — Deploy Route-Optimized Endpoint

```python
ENDPOINT_NAME = "fraud-detection-lakebase"

ServedModelInput(
    model_name="tko2026.tko.credit_card_fraud_model",
    model_version=<latest>,
    workload_type=CPU, workload_size="Small",
    scale_to_zero_enabled=False,
    environment_vars={
        "CLIENT_ID":      "{{secrets/sp_blog/client_id}}",
        "CLIENT_SECRET":  "{{secrets/sp_blog/client_secret}}",
        "OIDC_TOKEN_URL": "https://adb-7405612444656138.18.azuredatabricks.net/oidc/v1/token",
        "DB_HOST":        "ep-crimson-meadow-e1ckeiiu.database.eastus2.azuredatabricks.net",
        "DB_NAME":        "databricks_postgres",
        "DB_PORT":        "5432",
    }
)
```

Create or update logic: try `get()` → `update_config()`, catch not-found → `create(route_optimized=True)`.

---

## Step 7 — Test Endpoint

Use `serving_endpoints_data_plane.query()` (NOT `requests.post`) for route-optimized endpoints.

### Latency Benchmark

```
Single record: warmup=5, requests=50, delay=0.1s
Burst test:    warmup=3, requests=100, delay=0s
Metrics: min, max, mean, median, p50, p90, p95, p99 (ms)
```

---

## Backend API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/version` | App version |
| `GET` | `/api/users` | List 20 demo users (for dropdown) |
| `GET` | `/api/profile?user_id=X` | Get user profile from customer_features |
| `POST` | `/api/profile` | Save profile directly to customer_features |
| `POST` | `/api/transactions` | Process transaction (model + business rules) |

### Transaction Processing (`POST /api/transactions`)

**Input:**
```json
{
  "user_id": "usr-001",
  "country": "Nigeria",
  "country_code": "NG",
  "amount": 9500,
  "credit_card_number": "1000000000000000",
  "currency": "USD"
}
```

**Processing order:**
1. **Always** call fraud model → get fraud_probability, fraud_flag, latency
2. Check business rules against user profile in Postgres:
   - `amount > daily_limit` → DECLINED
   - `!allow_international_transactions && country_code != country_of_residence` → DECLINED
3. Every response includes latency breakdown (model serving, DB lookup, inference)

**Output:**
```json
{
  "id": "uuid",
  "transaction_number": "TXN-20260405-1234",
  "status": "declined",
  "fraud_probability": 0.2860,
  "fraud_flag": 1,
  "decline_reason": "Fraud detected — probability 28.6%...",
  "latency": {
    "backend_total_ms": 125.5,
    "model_call_ms": 95.3,
    "model_lookup_ms": 3.5,
    "model_inference_ms": 1.2,
    "model_total_ms": 4.7
  }
}
```

---

## Frontend Architecture

| Component | Description |
|---|---|
| **UserContext** | Global selected user state, persisted to localStorage |
| **Transaction Page** | World map (click country), amount slider, read-only card from profile, card tap animation with latency waterfall |
| **Profile Page** | User dropdown (20 users), editable settings, direct Postgres save, EventHub section (coming soon) |
| **CardTapAnimation** | Multi-stage animation: card tap → pulse → approve/decline icon → latency breakdown bars |
| **WorldMap** | Interactive SVG map, numeric→alpha-2 country code mapping |

---

## App Configuration

### `app.yml`
```yaml
command: ["uvicorn", "retail_app.backend.app:app", "--workers", "2"]
env:
  - name: OIDC_TOKEN_URL
    value: "https://adb-7405612444656138.18.azuredatabricks.net/oidc/v1/token"
  - name: DB_HOST
    value: "ep-crimson-meadow-e1ckeiiu.database.eastus2.azuredatabricks.net"
  - name: DB_NAME
    value: "databricks_postgres"
  - name: DB_PORT
    value: "5432"
```

**Note:** CLIENT_ID and CLIENT_SECRET are loaded at runtime via Databricks SDK secrets API (not app.yml `valueFrom`).

### `databricks.yml`
```yaml
bundle:
  name: retail-app
targets:
  dev:
    mode: development
    default: true
    workspace:
      profile: fevm
```

---

## Decision Scenarios Summary

| Scenario | Decided By | Example |
|---|---|---|
| High-risk card + any transaction | **Model** (fraud_prob >= 15%) | usr-001, usr-012 with any country/amount |
| Low-risk card + amount > daily_limit | **Business Rule** | usr-006 ($2K limit) with $3K transaction |
| Low-risk card + intl disabled + foreign country | **Business Rule** | usr-003 (JP, intl=off) transacting in US |
| Low-risk card + within limits + domestic | **Approved** | usr-002 (US) transacting in US for $500 |

### High-Risk Demo Users (Model Will Decline)

| User | Name | Country | Card BIN | Why High-Risk |
|---|---|---|---|---|
| usr-001 | John Doe | US | 100000 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-004 | Maria Garcia | ES | 100003 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-005 | Hans Mueller | DE | 100004 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-007 | Sophie Laurent | FR | 100006 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-008 | Lucas Silva | BR | 100007 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-009 | Emma Wilson | GB | 100008 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-012 | Carlos Hernandez | MX | 100011 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-014 | Ahmed Al-Rashid | AE | 100013 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-017 | Sarah Johnson | CA | 100016 | risk_tier=3, high chargeback/velocity/cross-border |
| usr-019 | Lin Zhang | SG | 100018 | risk_tier=3, high chargeback/velocity/cross-border |

### Low-Risk Demo Users (Model Will Approve)

| User | Name | Country | Card BIN | Intl Txn | Daily Limit |
|---|---|---|---|---|---|
| usr-002 | Jane Smith | US | 100001 | Yes | $10,000 |
| usr-003 | Akira Tanaka | JP | 100002 | **No** | $3,000 |
| usr-006 | Priya Sharma | IN | 100005 | **No** | $2,000 |
| usr-010 | Wei Chen | CN | 100009 | **No** | $5,000 |
| usr-011 | Olivia Brown | AU | 100010 | Yes | $7,000 |
| usr-013 | Yuki Sato | JP | 100012 | Yes | $6,000 |
| usr-015 | Anna Kowalski | DE | 100014 | Yes | $4,500 |
| usr-016 | David Kim | KR | 100015 | **No** | $5,000 |
| usr-018 | Marco Rossi | IT | 100017 | Yes | $5,500 |
| usr-020 | Fatima Okafor | ZA | 100019 | Yes | $3,000 |

---

## Critical Implementation Constraints

| # | Constraint |
|---|---|
| 1 | `fraud_model.py` must end with `mlflow.models.set_model(FraudDetectionModel())` |
| 2 | Code-based logging: `python_model=<path_string>`, NOT object instance |
| 3 | `load_context` initializes token manager + pool; `predict` uses pre-warmed connections |
| 4 | All shared state uses `threading.Lock()`; old pool closed after 30s via `threading.Timer` |
| 5 | Secrets injected to serving endpoint as `"{{secrets/scope/key}}"` (double curly braces) |
| 6 | Endpoint created with `route_optimized=True`; use `update_config()` for updates |
| 7 | Test via `serving_endpoints_data_plane.query()` — NOT `requests.post` |
| 8 | `mlflow.set_registry_uri("databricks-uc")` before any `log_model` call |
| 9 | `scale_to_zero_enabled=False` for no cold starts |
| 10 | Delta writes use `.option("overwriteSchema", "true")` for schema evolution |
| 11 | App loads SP credentials from Databricks SDK secrets API (not app.yml `valueFrom`) |
| 12 | Country codes are 2-letter ISO (alpha-2) throughout the entire stack |
| 13 | Fraud model always called first; business rules applied after (latency on every txn) |

---

## Future Iteration: EventHub Pipeline

Currently profile updates write directly to Postgres. The next iteration will add:

```
App → Azure EventHub → Spark Structured Streaming → PostgreSQL
```

- EventHub namespace: `dlt-eventhub`
- Topic: `user-profile-updates`
- The profile page already has the EventHub UI section (marked "Coming Soon")
- `eventhub.py` Kafka producer is already in the codebase

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
