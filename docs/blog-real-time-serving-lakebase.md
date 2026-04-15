# What happens in the milliseconds after you tap pay

You're standing at the register. You tap your card. A tiny spinner appears for maybe half a second, maybe less, and then it says **Approved**. Or it doesn't.

During that time, something had to decide whether this charge looks like you, or like someone who stole your card number in a data breach six months ago. It had to know things about you: your spending patterns, your daily limit, whether you even allow purchases from other countries. And it had to do all of that fast enough that you don't notice it happened.

This post is about what that "something" looks like when you build it on Databricks. We'll walk through **retail-app**, a sample application (FastAPI backend, React frontend, built with [apx](https://docs.databricks.com/en/dev-tools/databricks-apps/app-development.html)) that brings three platform capabilities together:

- **Model Serving with route optimization**, a faster network path to your deployed model
- **Lakebase**, a managed Postgres for the profile and feature data the model needs at prediction time
- **Lakebase Autoscaling**, so the database scales with demand instead of becoming the new bottleneck

The [full repo is on GitHub](#), you can fork it, deploy it to your workspace, and tap "pay" yourself.

---

## The flow: what actually happens on a transaction

Before we look at code, here's the plain story of a single payment. Two checks run in sequence: an AI model scores the charge, then the app checks your profile rules. Either one can decline the transaction.

**Customer taps pay → Fraud model scores the charge → Profile rules checked → Approved or declined**

That's it. The model runs first because we want its latency numbers regardless of the outcome. Then the profile lookup (daily spending cap, international transaction toggle, country of residence) feeds a handful of if-statements. The response includes timing for every step so you can see exactly where the milliseconds went.

**Updating your profile** (changing your daily limit, toggling international transactions) is a separate action. You save changes to the database, and the *next* payment picks them up. No redeployment, no cache invalidation.

---

## Route optimization: why the network path matters

When a model is deployed behind Databricks Model Serving, there's a network hop between your application and the inference container. For batch workloads, a few extra milliseconds per request is irrelevant. For a checkout experience, it's everything.

[Route optimization](https://docs.databricks.com/aws/en/machine-learning/model-serving/route-optimization) shortens that network path. You enable it when you create the endpoint, and you query through the **data-plane** flow using OAuth, not personal access tokens. You get lower latency and higher throughput for the same compute, which is exactly what an interactive fraud-scoring use case needs.

In the sample app, the endpoint is called `fraud-detection-lakebase`. Here's the constant and the function that calls it:

```python
# src/retail_app/backend/router.py

FRAUD_ENDPOINT_NAME = "fraud-detection-lakebase"

async def _check_fraud(
    ws: WorkspaceClient, txn: TransactionIn
) -> dict[str, Any]:
    payload = [
        {
            "user": txn.user_id,
            "country": txn.country,
            "country_code": txn.country_code,
            "amount": txn.amount,
            "credit_card": _format_credit_card(txn.credit_card_number),
            "currency": txn.currency,
        }
    ]

    start = time.perf_counter()
    response = await asyncio.to_thread(
        ws.serving_endpoints_data_plane.query,
        name=FRAUD_ENDPOINT_NAME,
        dataframe_records=payload,
    )
    model_call_ms = (time.perf_counter() - start) * 1000
```

A few things to notice:

- `**serving_endpoints_data_plane.query**`: This is the data-plane query path, which is what route optimization uses. The Databricks SDK handles the OAuth token exchange under the hood.
- `**asyncio.to_thread**`: The SDK's query method is synchronous. Wrapping it in `to_thread` keeps the FastAPI event loop free while the model runs.
- `**dataframe_records**`: The payload is a list of dictionaries (one per row). For fraud scoring, we send one transaction at a time.

The model itself returns `fraud_probability`, `fraud_flag`, and (crucially) its own internal timing: `lookup_ms` (how long the feature lookup inside the model container took), `inference_ms` (CatBoost prediction), and `total_ms`. The backend maps these through so the frontend can show a latency waterfall:

```python
# src/retail_app/backend/router.py

prediction = predictions[0]
return {
    "fraud_probability": prediction["fraud_probability"],
    "fraud_flag": prediction["fraud_flag"],
    "model_call_ms": model_call_ms,
    "model_lookup_ms": prediction.get("lookup_ms"),
    "model_inference_ms": prediction.get("inference_ms"),
    "model_total_ms": prediction.get("total_ms"),
}
```

So when you see "Model: 45ms (lookup: 8ms, inference: 3ms)" in the UI, those aren't made-up numbers. They're measured at each layer and stitched together in a single response.

For more on setting this up: [Route optimization](https://docs.databricks.com/aws/en/machine-learning/model-serving/route-optimization) · [Querying route-optimized endpoints](https://docs.databricks.com/aws/en/machine-learning/model-serving/query-route-optimization).

---

## Lakebase: Postgres for the data the model needs

The fraud model doesn't just look at the transaction in isolation. It looks up the customer's historical features (average transaction amount, cross-border ratio, chargeback rate, velocity over the past 24 hours) using the first six digits of the credit card (the BIN) as the lookup key. Those features live in a [Lakebase](https://docs.databricks.com/aws/en/oltp) Postgres table called `customer_features`.

This is the same table the *backend* reads from for profile data (name, daily limit, international toggle). One table, two readers: the model container reads features for inference, the FastAPI app reads profile fields for business rules.

On the read side, the backend borrows a connection from the pool, runs a parameterized `SELECT` by `user_id`, and returns the connection in a `finally` block. Straightforward psycopg2, but the borrow/return discipline matters when this runs on every transaction. The query uses parameterized placeholders (not string interpolation), so the lookup key is never concatenated into the SQL.

On the write side, when a user changes their daily limit or toggles international transactions in the UI, the backend builds a dynamic `UPDATE` from an allowlist of editable columns. Only fields on that list are written; the client can't inject arbitrary column names. The write runs with `autocommit = True`, so the change is immediately visible: the very next transaction sees the updated limit without waiting for a batch flush or cache invalidation.

---

## Connection pooling and OAuth token rotation

Every transaction in this app hits Postgres at least twice: once inside the model container for the feature lookup, and once in the backend for the profile check. Opening a fresh connection each time means a TCP handshake plus a TLS negotiation on every single request, which would easily add 20-50 ms of overhead per call. A connection pool keeps a handful of connections open and ready, so most requests just grab one and go.

Here's what that looks like in practice. Every database operation follows the same borrow/query/return pattern:

```python
# src/retail_app/backend/postgres.py

def list_users() -> list[dict[str, Any]]:
    pool = _ensure_pool()
    conn = pool.getconn()                          # borrow
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"SELECT user_id, full_name, email, credit_card_number "
                f"FROM {TABLE} WHERE user_id IS NOT NULL "
                f"ORDER BY user_id"
            )
            return [_to_dict(row) for row in cur.fetchall()]
    finally:
        pool.putconn(conn)                         # return
```

Borrow a connection, run your query, return the connection in a `finally` block so it always goes back even if something throws. Every read and write in the app follows this same shape.

The pool itself is a `psycopg2.pool.ThreadedConnectionPool` with 3–10 connections. But building it is where things get interesting, because Lakebase authenticates via OAuth. The app exchanges service principal credentials for an access token, then uses the **client ID as the Postgres username** and the **token as the password**. No long-lived database passwords.

That means when the token expires, you can't just keep using the old password on pooled connections, because they'd fail on the next query. So `_ensure_pool` checks whether the token has changed, and if it has, builds a fresh pool:

```python
# src/retail_app/backend/postgres.py

def _ensure_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool, _pool_token

    client_id, _ = _ensure_credentials()
    current_token = _get_oauth_token()

    # Fast path: pool exists and token hasn't changed
    if _pool is not None and _pool_token == current_token:
        return _pool

    with _pool_lock:
        # Double-check after acquiring lock
        if _pool is not None and _pool_token == current_token:
            return _pool

        old_pool = _pool

        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=3,
            maxconn=10,
            host=PG_HOST,
            port=PG_PORT,
            dbname=PG_DB,
            user=client_id,
            password=current_token,
            sslmode="require",
            connect_timeout=10,
        )
        _pool_token = current_token

        # Close old pool after a delay so in-flight queries finish
        if old_pool is not None:
            threading.Timer(30.0, _close_pool, [old_pool]).start()

        return _pool
```

Most of the time, the fast path fires: the pool exists, the token hasn't changed, and we return immediately. When the token does rotate, the double-check locking keeps two threads from rebuilding the pool at the same time, and the 30-second timer on closing the old pool gives in-flight queries time to finish before their connections disappear. Small detail, but it's the difference between "works in a demo" and "works under load."

---

## The model's side: feature lookup inside the container

The fraud model itself (deployed as an MLflow pyfunc) does its *own* Lakebase lookup at prediction time. It extracts the card BIN, queries `customer_features`, assembles a feature vector, and runs CatBoost inference. Each step is timed:

```python
# model_training/fraud_model.py (inside FraudDetectionModel.predict)

card_bin = self._extract_card_bin(row["credit_card"])

t_lookup_start = time.perf_counter()
features = self._lookup_customer_features(card_bin)
lookup_ms = (time.perf_counter() - t_lookup_start) * 1000

# ... assemble feature vector from looked-up data ...

t_infer_start = time.perf_counter()
fraud_prob = float(self.model.predict_proba(feature_vector)[0, 1])
inference_ms = (time.perf_counter() - t_infer_start) * 1000
```

The model container maintains its own `ThreadedConnectionPool` to Lakebase (the `LakebaseConnectionPool` class in `fraud_model.py`), with background token refresh so the pool stays valid across long-running serving instances. This is the same pattern as the backend (pool + OAuth rotation), but running inside the model container rather than the FastAPI process.

Those `lookup_ms` and `inference_ms` values flow back through the serving response, through the backend, and into the frontend. That's how you get end-to-end visibility: the model reports its internal timing, the backend adds its own wall-clock measurement, and the user sees all of it.

---

## Business rules: the profile check

After the model scores the transaction, the backend reads the customer's profile from Lakebase and runs two simple rules. First, it compares the transaction amount against the user's daily spending limit. If the charge exceeds the cap, the transaction is declined with a message telling the user they can raise it in their profile settings. Second, if the user has disabled international transactions, the backend checks whether the transaction's country matches the user's country of residence. A mismatch means a decline.

Either rule can *override* a model approval. A transaction the model thinks is fine can still be declined because the user set a $500 daily cap. That's intentional. The model handles statistical risk; the profile handles user preferences. Both read from the same Lakebase table, but they serve different purposes.

The time spent on the profile lookup and rule checks is tracked as `business_logic_ms` and returned alongside the model timing, so you can see exactly how much overhead the business logic adds to each transaction.

---

## Lakebase Autoscaling: handling demand

In production, your Postgres instance needs to handle both the model container's feature lookups *and* the backend's profile reads, potentially many of each per second during peak hours. [Lakebase Autoscaling](https://docs.databricks.com/aws/en/oltp/autoscaling) adjusts compute within a configured min/max range so you're not paying for peak capacity at 3 AM, but you're also not dropping queries at noon.

Here's the thing: optimizing the serving layer (route optimization for low-latency inference) only helps if the database behind it can keep up. If the model's feature lookup blocks on a saturated Postgres connection, you've moved the bottleneck rather than removing it. Autoscaling is how you avoid that.

In the benchmark results below, the consistent single-digit lookup times at p50 through p75 reflect what a warmed Lakebase instance delivers under steady load. The jump at p95 (13.9 ms) is typical of connection pool churn or brief scale-up events, still well within the latency budget for a checkout flow, and exactly the kind of spike that autoscaling absorbs before it becomes user-visible. With scale-to-zero enabled, you also stop paying when no transactions are flowing. The instance spins back up on the first request and is ready within seconds.

---

## Putting it together

Here's the full latency picture for a single transaction:


| Measurement          | What it captures                            | Where it's measured      |
| -------------------- | ------------------------------------------- | ------------------------ |
| `model_call_ms`      | Wall-clock time for the entire serving call | Backend (`router.py`)    |
| `model_lookup_ms`    | Feature lookup inside the model container   | Model (`fraud_model.py`) |
| `model_inference_ms` | CatBoost prediction time                    | Model (`fraud_model.py`) |
| `model_total_ms`     | Total time inside the model container       | Model (`fraud_model.py`) |
| `business_logic_ms`  | Profile read + rule evaluation              | Backend (`router.py`)    |
| `backend_total_ms`   | Everything from request to response         | Backend (`router.py`)    |


The gap between `model_total_ms` and `model_call_ms` is network overhead, and that's exactly where route optimization helps. The gap between `backend_total_ms` and `model_call_ms + business_logic_ms` is framework overhead (serialization, routing, etc.).

When you run the app and submit a transaction, the UI shows all of these. Makes it easy to see the difference route optimization makes, or to show that a Lakebase feature lookup adds single-digit milliseconds rather than the hundreds you might expect from a cold database connection.

---

## Results: How fast is it really?

We sent **5,000 requests** to the route-optimized `fraud-detection-lakebase` endpoint (CPU, "Small" workload size, single Azure region) and collected latency at every layer, from within the model container to the caller's round-trip.


| Metric                                      | What it measures                             | p50     | p75     | p90     | p95     |
| ------------------------------------------- | -------------------------------------------- | ------- | ------- | ------- | ------- |
| **Feature lookup** (`lookup_ms`)            | Lakebase read inside the model container     | 8.9 ms  | 9.8 ms  | 11.7 ms | 13.9 ms |
| **Inference** (`inference_ms`)              | CatBoost prediction                          | 0.4 ms  | 0.5 ms  | 1.6 ms  | 6.0 ms  |
| **Total model time** (`total_ms`)           | Lookup + inference + container overhead      | 9.5 ms  | 10.9 ms | 14.9 ms | 17.6 ms |
| **End-to-end round trip** (`round_trip_ms`) | Full data-plane call from caller to response | 27.2 ms | 29.6 ms | 33.8 ms | 37.3 ms |
| **Network overhead**                        | Round trip minus model time                  | 17.4 ms | 18.5 ms | 19.8 ms | 21.1 ms |


**5,000/5,000 calls succeeded.**

A few things stand out:

- **End-to-end round trip is 27 ms at the median, 37 ms at p95.** That's the full journey: caller → route-optimized data plane → model container → Lakebase lookup → CatBoost inference → response. Well within the latency budget for a checkout flow.
- **Feature lookup is single-digit milliseconds at p50 (8.9 ms).** The model's connection pool to Lakebase keeps connections warm, so most reads skip the TLS handshake entirely. Even at p95 the lookup stays under 14 ms.
- **Inference is essentially free.** CatBoost prediction on a 12-feature vector takes 0.4 ms at the median. The model's time is dominated by the feature lookup, not the prediction itself.
- **Network overhead is ~17 ms.** The gap between what the model container reports and what the caller sees is the serving infrastructure: request routing, serialization, and the data-plane hop. Route optimization keeps this consistent: the p50-to-p95 spread is only 4 ms.

---

## Try it yourself

The app is built with [apx](https://docs.databricks.com/en/dev-tools/databricks-apps/app-development.html) (Databricks' toolkit for full-stack apps). To run locally:

```bash
apx dev start     # starts FastAPI + React dev servers
apx dev logs      # tail the backend logs
```

To deploy to your workspace:

```bash
apx build
databricks bundle deploy -t dev
```

The key files:

- `src/retail_app/backend/router.py`: Transaction endpoint, fraud check, business rules
- `src/retail_app/backend/postgres.py`: Lakebase connection pool, profile CRUD
- `model_training/fraud_model.py`: MLflow pyfunc with feature lookup and CatBoost
- `app.yml`: Deployment config (uvicorn entrypoint, environment variables)

---

## Related documentation

- [Model Serving: Route optimization](https://docs.databricks.com/aws/en/machine-learning/model-serving/route-optimization)
- [Querying route-optimized serving endpoints](https://docs.databricks.com/aws/en/machine-learning/model-serving/query-route-optimization)
- [Optimize serving endpoints for production](https://docs.databricks.com/aws/en/machine-learning/model-serving/production-optimization)
- [Lakebase (OLTP)](https://docs.databricks.com/aws/en/oltp)
- [Lakebase Autoscaling](https://docs.databricks.com/aws/en/oltp/autoscaling)
- [Databricks Apps](https://docs.databricks.com/en/dev-tools/databricks-apps/app-development.html)
- [MLflow code-based models](https://mlflow.org/docs/latest/models.html#python-function-python-model)

