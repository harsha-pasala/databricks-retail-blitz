# Databricks notebook source
# MAGIC %md
# MAGIC # Credit Card Fraud Detection — End-to-End Pipeline
# MAGIC
# MAGIC **Architecture:** Incoming payload → Business Rules → Model Serving → BIN extraction → Lakebase feature lookup → CatBoost inference
# MAGIC
# MAGIC **Steps:**
# MAGIC 1. Synthetic data generation (customer features + user profiles + transactions)
# MAGIC 2. Populate Lakebase feature table (with merged profile data)
# MAGIC 3. Model training (CatBoost)
# MAGIC 4. Log & register model (code-based logging)
# MAGIC 5. Deploy route-optimized endpoint
# MAGIC 6. Test endpoint via SDK data plane API

# COMMAND ----------

# MAGIC %pip install --quiet --upgrade "databricks-sdk>=0.28,<1" catboost==1.2.8 cloudpickle==2.2.1 psycopg2-binary==2.9.9
# MAGIC %restart_python

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os

CATALOG = "tko2026"
SCHEMA = "tko"
UC_MODEL_NAME = f"{CATALOG}.{SCHEMA}.credit_card_fraud_model"
ENDPOINT_NAME = "fraud-detection-lakebase"
WORKSPACE_HOST = "adb-7405612444656138.18.azuredatabricks.net"
OIDC_TOKEN_URL = f"https://{WORKSPACE_HOST}/oidc/v1/token"

DB_HOST = "ep-crimson-meadow-e1ckeiiu.database.eastus2.azuredatabricks.net"
DB_NAME = "databricks_postgres"
DB_PORT = "5432"

# Retrieve SP credentials from secrets (fallback to hardcoded for demo)
try:
    CLIENT_ID = dbutils.secrets.get(scope="sp_blog", key="client_id")
    CLIENT_SECRET = dbutils.secrets.get(scope="sp_blog", key="client_secret")
except Exception:
    CLIENT_ID = "<<Put Your client id for testing>>"
    CLIENT_SECRET = "<<Put Your secret for testing>>"

os.environ["CLIENT_ID"] = CLIENT_ID
os.environ["CLIENT_SECRET"] = CLIENT_SECRET
os.environ["OIDC_TOKEN_URL"] = OIDC_TOKEN_URL
os.environ["DB_HOST"] = DB_HOST
os.environ["DB_NAME"] = DB_NAME
os.environ["DB_PORT"] = DB_PORT

spark.sql(f"USE CATALOG {CATALOG}")
spark.sql(f"USE SCHEMA {SCHEMA}")
print(f"Catalog: {CATALOG}, Schema: {SCHEMA}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 1 — Synthetic Data Generation

# COMMAND ----------

import numpy as np
import pandas as pd
from pyspark.sql import functions as F
from pyspark.sql.types import *

np.random.seed(42)
NUM_CUSTOMERS = 50_000
NUM_TRANSACTIONS = 200_000

# --- Customer Features ---
card_networks = ["Visa", "Mastercard", "Amex", "Discover", "UnionPay"]
country_codes = ["US", "GB", "DE", "FR", "JP", "CN", "IN", "BR", "AU", "CA",
                 "MX", "KR", "SG", "AE", "ZA", "IT", "ES", "NL", "SE", "CH"]

# Generate unique 6-digit BINs
bins = [str(100000 + i) for i in range(NUM_CUSTOMERS)]

risk_tiers = np.random.choice([1, 2, 3], size=NUM_CUSTOMERS, p=[0.60, 0.30, 0.10])

customers = pd.DataFrame({
    "card_bin": bins,
    "card_network": np.random.choice(card_networks, NUM_CUSTOMERS),
    "country_of_residence": np.random.choice(country_codes, NUM_CUSTOMERS),
    "avg_transaction_amount": np.round(np.random.lognormal(mean=4.5, sigma=1.0, size=NUM_CUSTOMERS), 2),
    "daily_transaction_count": np.random.poisson(lam=8, size=NUM_CUSTOMERS),
    "cross_border_ratio": np.round(np.random.beta(2, 8, size=NUM_CUSTOMERS), 4),
    "high_risk_merchant_ratio": np.round(np.random.beta(1.5, 10, size=NUM_CUSTOMERS), 4),
    "chargeback_rate": np.round(np.random.beta(1, 80, size=NUM_CUSTOMERS), 5),
    "avg_fraud_score_30d": np.round(np.random.beta(2, 20, size=NUM_CUSTOMERS), 4),
    "velocity_24h": np.random.poisson(lam=5, size=NUM_CUSTOMERS),
    "is_corporate_card": np.random.choice([0, 1], NUM_CUSTOMERS, p=[0.85, 0.15]),
    "risk_tier": risk_tiers,
})

# Skew features for high-risk tiers
for idx in customers[customers["risk_tier"] == 3].index:
    customers.loc[idx, "chargeback_rate"] = np.round(np.random.uniform(0.02, 0.05), 5)
    customers.loc[idx, "high_risk_merchant_ratio"] = np.round(np.random.uniform(0.2, 0.5), 4)
    customers.loc[idx, "velocity_24h"] = np.random.randint(15, 40)
    customers.loc[idx, "cross_border_ratio"] = np.round(np.random.uniform(0.5, 0.9), 4)
    customers.loc[idx, "avg_fraud_score_30d"] = np.round(np.random.uniform(0.3, 0.8), 4)

for idx in customers[customers["risk_tier"] == 2].index:
    customers.loc[idx, "chargeback_rate"] = np.round(np.random.uniform(0.005, 0.02), 5)
    customers.loc[idx, "high_risk_merchant_ratio"] = np.round(np.random.uniform(0.08, 0.25), 4)
    customers.loc[idx, "velocity_24h"] = np.random.randint(8, 20)

# Generate full 16-digit credit card numbers (BIN + 10 random digits)
np.random.seed(99)
customers["credit_card_number"] = customers["card_bin"].apply(
    lambda b: b + "".join([str(np.random.randint(0, 10)) for _ in range(10)])
)

# --- Add profile columns (NULL by default for non-demo users) ---
customers["user_id"] = None
customers["full_name"] = None
customers["email"] = None
customers["phone"] = None
customers["preferred_currency"] = None
customers["allow_international_transactions"] = None
customers["daily_limit"] = None
customers["enable_notifications"] = None
customers["two_factor_enabled"] = None

# --- 20 Demo Users with full profiles ---
DEMO_USERS = [
    {"user_id": "usr-001", "full_name": "John Doe", "email": "john.doe@databricks.com", "phone": "+1 (555) 234-5678", "country_of_residence": "US", "preferred_currency": "USD", "allow_international_transactions": True, "daily_limit": 5000.0},
    {"user_id": "usr-002", "full_name": "Jane Smith", "email": "jane.smith@databricks.com", "phone": "+1 (555) 345-6789", "country_of_residence": "US", "preferred_currency": "USD", "allow_international_transactions": True, "daily_limit": 10000.0},
    {"user_id": "usr-003", "full_name": "Akira Tanaka", "email": "akira.tanaka@databricks.com", "phone": "+81 90-1234-5678", "country_of_residence": "JP", "preferred_currency": "JPY", "allow_international_transactions": False, "daily_limit": 3000.0},
    {"user_id": "usr-004", "full_name": "Maria Garcia", "email": "maria.garcia@databricks.com", "phone": "+34 612 345 678", "country_of_residence": "ES", "preferred_currency": "EUR", "allow_international_transactions": True, "daily_limit": 7500.0},
    {"user_id": "usr-005", "full_name": "Hans Mueller", "email": "hans.mueller@databricks.com", "phone": "+49 170 1234567", "country_of_residence": "DE", "preferred_currency": "EUR", "allow_international_transactions": True, "daily_limit": 8000.0},
    {"user_id": "usr-006", "full_name": "Priya Sharma", "email": "priya.sharma@databricks.com", "phone": "+91 98765 43210", "country_of_residence": "IN", "preferred_currency": "INR", "allow_international_transactions": False, "daily_limit": 2000.0},
    {"user_id": "usr-007", "full_name": "Sophie Laurent", "email": "sophie.laurent@databricks.com", "phone": "+33 6 12 34 56 78", "country_of_residence": "FR", "preferred_currency": "EUR", "allow_international_transactions": True, "daily_limit": 6000.0},
    {"user_id": "usr-008", "full_name": "Lucas Silva", "email": "lucas.silva@databricks.com", "phone": "+55 11 98765-4321", "country_of_residence": "BR", "preferred_currency": "BRL", "allow_international_transactions": True, "daily_limit": 4000.0},
    {"user_id": "usr-009", "full_name": "Emma Wilson", "email": "emma.wilson@databricks.com", "phone": "+44 7911 123456", "country_of_residence": "GB", "preferred_currency": "GBP", "allow_international_transactions": True, "daily_limit": 9000.0},
    {"user_id": "usr-010", "full_name": "Wei Chen", "email": "wei.chen@databricks.com", "phone": "+86 138 0013 8000", "country_of_residence": "CN", "preferred_currency": "USD", "allow_international_transactions": False, "daily_limit": 5000.0},
    {"user_id": "usr-011", "full_name": "Olivia Brown", "email": "olivia.brown@databricks.com", "phone": "+61 412 345 678", "country_of_residence": "AU", "preferred_currency": "AUD", "allow_international_transactions": True, "daily_limit": 7000.0},
    {"user_id": "usr-012", "full_name": "Carlos Hernandez", "email": "carlos.hernandez@databricks.com", "phone": "+52 55 1234 5678", "country_of_residence": "MX", "preferred_currency": "MXN", "allow_international_transactions": True, "daily_limit": 3500.0},
    {"user_id": "usr-013", "full_name": "Yuki Sato", "email": "yuki.sato@databricks.com", "phone": "+81 80-5678-1234", "country_of_residence": "JP", "preferred_currency": "JPY", "allow_international_transactions": True, "daily_limit": 6000.0},
    {"user_id": "usr-014", "full_name": "Ahmed Al-Rashid", "email": "ahmed.alrashid@databricks.com", "phone": "+971 50 123 4567", "country_of_residence": "AE", "preferred_currency": "USD", "allow_international_transactions": True, "daily_limit": 15000.0},
    {"user_id": "usr-015", "full_name": "Anna Kowalski", "email": "anna.kowalski@databricks.com", "phone": "+48 512 345 678", "country_of_residence": "DE", "preferred_currency": "EUR", "allow_international_transactions": True, "daily_limit": 4500.0},
    {"user_id": "usr-016", "full_name": "David Kim", "email": "david.kim@databricks.com", "phone": "+82 10-1234-5678", "country_of_residence": "KR", "preferred_currency": "USD", "allow_international_transactions": False, "daily_limit": 5000.0},
    {"user_id": "usr-017", "full_name": "Sarah Johnson", "email": "sarah.johnson@databricks.com", "phone": "+1 (555) 456-7890", "country_of_residence": "CA", "preferred_currency": "CAD", "allow_international_transactions": True, "daily_limit": 8000.0},
    {"user_id": "usr-018", "full_name": "Marco Rossi", "email": "marco.rossi@databricks.com", "phone": "+39 333 123 4567", "country_of_residence": "IT", "preferred_currency": "EUR", "allow_international_transactions": True, "daily_limit": 5500.0},
    {"user_id": "usr-019", "full_name": "Lin Zhang", "email": "lin.zhang@databricks.com", "phone": "+65 9123 4567", "country_of_residence": "SG", "preferred_currency": "USD", "allow_international_transactions": True, "daily_limit": 10000.0},
    {"user_id": "usr-020", "full_name": "Fatima Okafor", "email": "fatima.okafor@databricks.com", "phone": "+27 82 123 4567", "country_of_residence": "ZA", "preferred_currency": "USD", "allow_international_transactions": True, "daily_limit": 3000.0},
]

for i, user in enumerate(DEMO_USERS):
    customers.loc[i, "user_id"] = user["user_id"]
    customers.loc[i, "full_name"] = user["full_name"]
    customers.loc[i, "email"] = user["email"]
    customers.loc[i, "phone"] = user["phone"]
    customers.loc[i, "country_of_residence"] = user["country_of_residence"]
    customers.loc[i, "preferred_currency"] = user["preferred_currency"]
    customers.loc[i, "allow_international_transactions"] = user["allow_international_transactions"]
    customers.loc[i, "daily_limit"] = user["daily_limit"]
    customers.loc[i, "enable_notifications"] = True
    customers.loc[i, "two_factor_enabled"] = False

print(f"Generated {len(customers)} customer features")
print(f"Risk tier distribution:\n{customers['risk_tier'].value_counts().sort_index()}")
print(f"Demo users assigned: {len(DEMO_USERS)}")

# COMMAND ----------

# --- Transaction Table ---
import uuid

tx_bins = np.random.choice(bins, size=NUM_TRANSACTIONS)
tx_countries = np.random.choice(country_codes, size=NUM_TRANSACTIONS)
currencies = ["USD", "EUR", "GBP", "JPY", "CNY", "AUD", "CAD", "CHF", "INR", "BRL"]

COUNTRY_NAMES_MAP = {
    "US": "United States", "GB": "United Kingdom", "DE": "Germany", "FR": "France",
    "JP": "Japan", "CN": "China", "IN": "India", "BR": "Brazil", "AU": "Australia",
    "CA": "Canada", "MX": "Mexico", "KR": "South Korea", "SG": "Singapore",
    "AE": "United Arab Emirates", "ZA": "South Africa", "IT": "Italy", "ES": "Spain",
    "NL": "Netherlands", "SE": "Sweden", "CH": "Switzerland",
}

transactions = pd.DataFrame({
    "transaction_id": [str(uuid.uuid4()) for _ in range(NUM_TRANSACTIONS)],
    "card_bin": tx_bins,
    "user": [f"usr_{uuid.uuid4().hex[:8]}" for _ in range(NUM_TRANSACTIONS)],
    "country": [COUNTRY_NAMES_MAP.get(cc, cc) for cc in tx_countries],
    "country_code": tx_countries,
    "amount": np.round(np.random.lognormal(mean=4.0, sigma=1.2, size=NUM_TRANSACTIONS), 2),
    "currency": np.random.choice(currencies, NUM_TRANSACTIONS),
})

# Generate fraud labels based on risk tier
cust_risk = customers.set_index("card_bin")["risk_tier"].to_dict()
cust_chargeback = customers.set_index("card_bin")["chargeback_rate"].to_dict()
cust_velocity = customers.set_index("card_bin")["velocity_24h"].to_dict()
cust_cross_border = customers.set_index("card_bin")["cross_border_ratio"].to_dict()

fraud_labels = []
for i in range(NUM_TRANSACTIONS):
    cb = tx_bins[i]
    tier = cust_risk.get(cb, 1)
    base_rate = {1: 0.008, 2: 0.04, 3: 0.15}.get(tier, 0.01)

    # Boost probability based on features
    boost = 0.0
    if cust_velocity.get(cb, 0) > 20:
        boost += 0.05
    if cust_cross_border.get(cb, 0) > 0.7:
        boost += 0.03
    if cust_chargeback.get(cb, 0) > 0.03:
        boost += 0.04
    if transactions.loc[i, "amount"] > 2000:
        boost += 0.03

    prob = min(base_rate + boost, 0.95)
    fraud_labels.append(1 if np.random.random() < prob else 0)

transactions["is_fraud"] = fraud_labels
print(f"Generated {len(transactions)} transactions")
print(f"Fraud rate: {transactions['is_fraud'].mean():.4f}")

# COMMAND ----------

# Write to Delta tables
customers_sdf = spark.createDataFrame(customers)
customers_sdf.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{CATALOG}.{SCHEMA}.customer_features")

transactions_sdf = spark.createDataFrame(transactions)
transactions_sdf.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{CATALOG}.{SCHEMA}.fraud_transactions")

print(f"Saved customer_features: {customers_sdf.count()} rows")
print(f"Saved fraud_transactions: {transactions_sdf.count()} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 2 — Populate Lakebase Feature Table

# COMMAND ----------

import requests as req
import psycopg2
from psycopg2.extras import execute_values

# Get OAuth token
token_resp = req.post(
    OIDC_TOKEN_URL,
    data={
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": "all-apis",
    },
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    timeout=10,
)
token_resp.raise_for_status()
oauth_token = token_resp.json()["access_token"]
print("OAuth token obtained")

# COMMAND ----------

# Connect and recreate table with merged profile columns
conn = psycopg2.connect(
    host=DB_HOST,
    dbname=DB_NAME,
    port=DB_PORT,
    user=CLIENT_ID,
    password=oauth_token,
    sslmode="require",
    connect_timeout=10,
)
conn.autocommit = True
cur = conn.cursor()

# Drop old table to recreate with new schema
cur.execute("DROP TABLE IF EXISTS customer_features CASCADE;")

cur.execute("""
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
""")

cur.execute("""
    CREATE INDEX IF NOT EXISTS idx_customer_features_card_bin
        ON customer_features(card_bin);
""")
cur.execute("""
    CREATE INDEX IF NOT EXISTS idx_customer_features_user_id
        ON customer_features(user_id);
""")
print("Lakebase table and indexes created")

# COMMAND ----------

# Bulk upsert all customer features
columns = [
    "card_bin", "card_network", "country_of_residence", "avg_transaction_amount",
    "daily_transaction_count", "cross_border_ratio", "high_risk_merchant_ratio",
    "chargeback_rate", "avg_fraud_score_30d", "velocity_24h", "is_corporate_card",
    "risk_tier", "credit_card_number", "user_id", "full_name", "email", "phone",
    "preferred_currency", "allow_international_transactions", "daily_limit",
    "enable_notifications", "two_factor_enabled",
]

def to_pg_val(v):
    """Convert pandas/numpy types to Postgres-compatible values."""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v

values = [tuple(to_pg_val(row[c]) for c in columns) for _, row in customers.iterrows()]

col_list = ", ".join(columns)
update_set = ", ".join(f"{c} = EXCLUDED.{c}" for c in columns if c != "card_bin")

insert_sql = f"""
    INSERT INTO customer_features ({col_list})
    VALUES %s
    ON CONFLICT (card_bin) DO UPDATE SET {update_set}
"""

BATCH_SIZE = 5000
for i in range(0, len(values), BATCH_SIZE):
    batch = values[i : i + BATCH_SIZE]
    execute_values(cur, insert_sql, batch, page_size=BATCH_SIZE)
    print(f"  Upserted rows {i} to {i + len(batch)}")

cur.close()
conn.close()
print(f"Lakebase populated with {len(values)} customer features")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 3 — Model Training

# COMMAND ----------

# Join transactions with customer features
cust_df = spark.table(f"{CATALOG}.{SCHEMA}.customer_features")
tx_df = spark.table(f"{CATALOG}.{SCHEMA}.fraud_transactions")

training_df = tx_df.join(cust_df, on="card_bin", how="inner")
training_pd = training_df.toPandas()

# Derive features
training_pd["amount_to_avg_ratio"] = training_pd["amount"] / training_pd["avg_transaction_amount"].clip(lower=0.01)
training_pd["is_cross_border"] = (training_pd["country_code"] != training_pd["country_of_residence"]).astype(int)

FEATURE_COLS = [
    "avg_transaction_amount", "daily_transaction_count", "cross_border_ratio",
    "high_risk_merchant_ratio", "chargeback_rate", "avg_fraud_score_30d",
    "velocity_24h", "is_corporate_card", "risk_tier",
    "amount", "amount_to_avg_ratio", "is_cross_border",
]

X = training_pd[FEATURE_COLS].values
y = training_pd["is_fraud"].values

print(f"Training set: {X.shape[0]} rows, {X.shape[1]} features")
print(f"Fraud rate: {y.mean():.4f}")

# COMMAND ----------

from catboost import CatBoostClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score, precision_score, recall_score, f1_score
import cloudpickle

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

model = CatBoostClassifier(
    iterations=300,
    learning_rate=0.05,
    depth=6,
    eval_metric="AUC",
    verbose=50,
    random_seed=42,
)
model.fit(X_train, y_train, eval_set=(X_test, y_test))

# Evaluate
y_proba = model.predict_proba(X_test)[:, 1]
y_pred = (y_proba >= 0.5).astype(int)

auc = roc_auc_score(y_test, y_proba)
precision = precision_score(y_test, y_pred)
recall = recall_score(y_test, y_pred)
f1 = f1_score(y_test, y_pred)

print(f"\nROC AUC:   {auc:.4f}")
print(f"Precision: {precision:.4f}")
print(f"Recall:    {recall:.4f}")
print(f"F1 Score:  {f1:.4f}")

# COMMAND ----------

# Save model artifact
os.makedirs("artifacts", exist_ok=True)
with open("artifacts/fraud_catboost_model.pkl", "wb") as f:
    cloudpickle.dump(model, f)

print("Model saved to artifacts/fraud_catboost_model.pkl")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 4 & 5 — Log and Register Model (Code-Based Logging)

# COMMAND ----------

import mlflow

mlflow.set_registry_uri("databricks-uc")

# Set experiment (needed when running outside a notebook context)
try:
    notebook_path = dbutils.notebook.entry_point.getDbutils().notebook().getContext().notebookPath().get()
    mlflow.set_experiment(notebook_path)
except Exception:
    mlflow.set_experiment("/Shared/blog-fraud-model/fraud_detection_experiment")

# Resolve fraud_model.py path
notebook_path = dbutils.notebook.entry_point.getDbutils().notebook().getContext().notebookPath().get()
notebook_dir = "/Workspace" + os.path.dirname(notebook_path)
model_code_path = os.path.join(notebook_dir, "fraud_model.py")

print(f"Model code path: {model_code_path}")
print(f"File exists: {os.path.exists(model_code_path)}")

# COMMAND ----------

import mlflow

input_example = pd.DataFrame([{
    "user": "usr-001",
    "country": "Germany",
    "country_code": "DE",
    "amount": 500.0,
    "credit_card": "1000 0012 3456 7890",
    "currency": "USD",
}])

output_example = pd.DataFrame([{
    "fraud_probability": 0.0312,
    "fraud_flag": 0,
    "card_bin": "100000",
    "lookup_ms": 3.5,
    "inference_ms": 1.2,
    "total_ms": 4.9,
    "error": None,
}])

with mlflow.start_run(run_name="fraud_detection_lakebase_v2"):
    mlflow.log_metric("roc_auc", auc)
    mlflow.log_metric("precision", precision)
    mlflow.log_metric("recall", recall)
    mlflow.log_metric("f1_score", f1)

    model_info = mlflow.pyfunc.log_model(
        artifact_path="fraud_model",
        python_model=model_code_path,
        artifacts={"model_pickle": "artifacts/fraud_catboost_model.pkl"},
        registered_model_name=UC_MODEL_NAME,
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
        ],
    )

print(f"Model registered: {UC_MODEL_NAME} version {model_info.registered_model_version}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 6 — Deploy Route-Optimized Endpoint

# COMMAND ----------

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import (
    ServedModelInput,
    EndpointCoreConfigInput,
    ServedModelInputWorkloadType,
)

w = WorkspaceClient()

served_model = ServedModelInput(
    model_name=UC_MODEL_NAME,
    model_version=model_info.registered_model_version,
    workload_type=ServedModelInputWorkloadType.CPU,
    workload_size="Small",
    scale_to_zero_enabled=False,
    environment_vars={
        "CLIENT_ID": "{{secrets/sp_blog/client_id}}",
        "CLIENT_SECRET": "{{secrets/sp_blog/client_secret}}",
        "OIDC_TOKEN_URL": OIDC_TOKEN_URL,
        "DB_HOST": DB_HOST,
        "DB_NAME": DB_NAME,
        "DB_PORT": DB_PORT,
    },
)

config = EndpointCoreConfigInput(
    name=ENDPOINT_NAME,
    served_models=[served_model],
)

# COMMAND ----------

# Create or update endpoint
try:
    existing = w.serving_endpoints.get(name=ENDPOINT_NAME)
    print(f"Endpoint '{ENDPOINT_NAME}' exists — updating config...")
    w.serving_endpoints.update_config(
        name=ENDPOINT_NAME,
        served_models=[served_model],
    ).result()
    print(f"Endpoint '{ENDPOINT_NAME}' updated with model version {model_info.registered_model_version}")
except Exception as e:
    if "does not exist" in str(e).lower() or "not_found" in str(e).lower() or "RESOURCE_DOES_NOT_EXIST" in str(e):
        print(f"Endpoint '{ENDPOINT_NAME}' not found — creating with route_optimized=True...")
        w.serving_endpoints.create(
            name=ENDPOINT_NAME,
            config=config,
            route_optimized=True,
        ).result()
        print(f"Endpoint '{ENDPOINT_NAME}' created")
    else:
        raise e

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 7 — Test Endpoint via SDK Data Plane API

# COMMAND ----------

import databricks.sdk.core as sdk_core
from databricks.sdk import WorkspaceClient

sp_config = sdk_core.Config(
    host=f"https://{WORKSPACE_HOST}",
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET,
)
sp_client = WorkspaceClient(config=sp_config)

# COMMAND ----------

# Smoke test (use BINs in our synthetic range: 100000-149999)
test_payload = [{
    "user": "usr-001",
    "country": "Germany",
    "country_code": "DE",
    "amount": 500.0,
    "credit_card": "1000 0012 3456 7890",
    "currency": "USD",
}]

print(f"Querying endpoint: {ENDPOINT_NAME}")
response = sp_client.serving_endpoints_data_plane.query(
    name=ENDPOINT_NAME,
    dataframe_records=test_payload,
)
print(f"Response: {response}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Latency Benchmarks

# COMMAND ----------

import time
import statistics

def measure_latency_sdk(client, endpoint_name, payload, num_requests=50,
                        warmup_requests=5, delay_between_requests=0.1):
    latencies = []
    errors = []

    print(f"Warmup: {warmup_requests} requests...")
    for i in range(warmup_requests):
        try:
            client.serving_endpoints_data_plane.query(
                name=endpoint_name, dataframe_records=payload)
        except Exception as e:
            print(f"  Warmup {i+1} error: {e}")
        time.sleep(delay_between_requests)

    print(f"Measuring: {num_requests} requests...")
    for i in range(num_requests):
        try:
            start = time.perf_counter()
            client.serving_endpoints_data_plane.query(
                name=endpoint_name, dataframe_records=payload)
            elapsed_ms = (time.perf_counter() - start) * 1000
            latencies.append(elapsed_ms)
            if (i + 1) % 10 == 0:
                print(f"  {i+1}/{num_requests}: {elapsed_ms:.2f}ms")
        except Exception as e:
            errors.append(str(e))
        time.sleep(delay_between_requests)

    if not latencies:
        return {"error": "No successful requests", "errors": errors}

    sorted_lat = sorted(latencies)
    return {
        "total_requests": num_requests,
        "successful": len(latencies),
        "failed": len(errors),
        "min_ms": min(latencies),
        "max_ms": max(latencies),
        "mean_ms": statistics.mean(latencies),
        "median_ms": statistics.median(latencies),
        "p50_ms": sorted_lat[int(len(sorted_lat) * 0.50)],
        "p90_ms": sorted_lat[int(len(sorted_lat) * 0.90)],
        "p95_ms": sorted_lat[int(len(sorted_lat) * 0.95)],
        "p99_ms": sorted_lat[-1] if len(sorted_lat) < 100 else sorted_lat[int(len(sorted_lat) * 0.99)],
    }

# COMMAND ----------

# Test 1: Single record benchmark
single_stats = measure_latency_sdk(
    client=sp_client,
    endpoint_name=ENDPOINT_NAME,
    payload=test_payload,
    num_requests=50,
    warmup_requests=5,
    delay_between_requests=0.1,
)
print("\n--- Single Record Latency ---")
for k, v in single_stats.items():
    if isinstance(v, float):
        print(f"  {k}: {v:.2f} ms")
    else:
        print(f"  {k}: {v}")

# COMMAND ----------

# Test 2: Burst test
burst_stats = measure_latency_sdk(
    client=sp_client,
    endpoint_name=ENDPOINT_NAME,
    payload=test_payload,
    num_requests=100,
    warmup_requests=3,
    delay_between_requests=0,
)
print("\n--- Burst Test Latency ---")
for k, v in burst_stats.items():
    if isinstance(v, float):
        print(f"  {k}: {v:.2f} ms")
    else:
        print(f"  {k}: {v}")

# COMMAND ----------

# Comparison summary
print("\n" + "=" * 70)
print("LATENCY COMPARISON")
print("=" * 70)
print(f"{'Test':<25} {'Mean (ms)':<15} {'P50 (ms)':<15} {'P95 (ms)':<15}")
print("-" * 70)
if "mean_ms" in single_stats:
    print(f"{'Single Record':<25} {single_stats['mean_ms']:<15.2f} {single_stats['p50_ms']:<15.2f} {single_stats['p95_ms']:<15.2f}")
if "mean_ms" in burst_stats:
    print(f"{'Burst (no delay)':<25} {burst_stats['mean_ms']:<15.2f} {burst_stats['p50_ms']:<15.2f} {burst_stats['p95_ms']:<15.2f}")
print("=" * 70)
