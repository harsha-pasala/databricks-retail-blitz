"""
Benchmark the fraud-detection-lakebase route-optimized serving endpoint.

Measures three latency layers:
  - lookup_ms    : Lakebase feature lookup inside the model container
  - total_ms     : Full model container time (lookup + inference + overhead)
  - round_trip_ms: End-to-end data-plane call from the caller's perspective

Uses the same auth pattern as model_training/fraud_detection_notebook.py:
  Config(host=..., client_id=..., client_secret=...) → data_plane.query()

Usage:
    python benchmark.py --client-id <id> --client-secret <secret>
    python benchmark.py --calls 5000 --delay 0.05 --client-id <id> --client-secret <secret>
"""

import argparse
import base64
import json
import math
import os
import sys
import time

import databricks.sdk.core as sdk_core
from databricks.sdk import WorkspaceClient

ENDPOINT = "fraud-detection-lakebase"
HOST = "https://adb-7405612444656138.18.azuredatabricks.net"

PAYLOADS = [
    [{"user": "usr-001", "country": "United States", "country_code": "US",
      "amount": 125.50, "credit_card": "1000 0220 8849 7549", "currency": "USD"}],
    [{"user": "usr-002", "country": "United Kingdom", "country_code": "GB",
      "amount": 89.99, "credit_card": "1000 0220 8849 7549", "currency": "GBP"}],
    [{"user": "usr-003", "country": "United States", "country_code": "US",
      "amount": 500.00, "credit_card": "1000 0220 8849 7549", "currency": "USD"}],
    [{"user": "usr-004", "country": "Germany", "country_code": "DE",
      "amount": 42.00, "credit_card": "1000 0220 8849 7549", "currency": "EUR"}],
    [{"user": "usr-005", "country": "Japan", "country_code": "JP",
      "amount": 15000, "credit_card": "1000 0220 8849 7549", "currency": "JPY"}],
]


def percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    rank = p / 100.0 * (len(sorted_vals) - 1)
    lo = int(math.floor(rank))
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = rank - lo
    return sorted_vals[lo] + frac * (sorted_vals[hi] - sorted_vals[lo])


SECRET_SCOPE = "sp_blog"


def build_client(client_id: str | None = None, client_secret: str | None = None) -> WorkspaceClient:
    """Same pattern as model_training/fraud_detection_notebook.py.
    If creds not provided, reads them from Databricks secrets (works on serverless)."""
    if not client_id or not client_secret:
        default_ws = WorkspaceClient(host=HOST)
        raw_id = default_ws.secrets.get_secret(SECRET_SCOPE, "client_id").value
        raw_secret = default_ws.secrets.get_secret(SECRET_SCOPE, "client_secret").value
        client_id = base64.b64decode(raw_id).decode("utf-8") if raw_id else ""
        client_secret = base64.b64decode(raw_secret).decode("utf-8") if raw_secret else ""
        print(f"Loaded SP credentials from secrets scope '{SECRET_SCOPE}'.", file=sys.stderr)

    sp_config = sdk_core.Config(
        host=HOST,
        client_id=client_id,
        client_secret=client_secret,
    )
    return WorkspaceClient(config=sp_config)


def run_benchmark(ws: WorkspaceClient, num_calls: int, delay: float, warmup: int = 5) -> list[dict]:
    print(f"Warming up with {warmup} calls...", file=sys.stderr)
    for i in range(warmup):
        ws.serving_endpoints_data_plane.query(
            name=ENDPOINT, dataframe_records=PAYLOADS[i % len(PAYLOADS)]
        )
    print("Warm-up done. Starting benchmark.\n", file=sys.stderr)

    results = []
    for i in range(num_calls):
        payload = PAYLOADS[i % len(PAYLOADS)]
        start = time.perf_counter()
        try:
            resp = ws.serving_endpoints_data_plane.query(
                name=ENDPOINT, dataframe_records=payload,
            )
            round_trip_ms = (time.perf_counter() - start) * 1000
            pred = resp.predictions[0] if resp.predictions else {}
            results.append({
                "i": i,
                "lookup_ms": pred.get("lookup_ms"),
                "inference_ms": pred.get("inference_ms"),
                "total_ms": pred.get("total_ms"),
                "round_trip_ms": round(round_trip_ms, 2),
            })
        except Exception as e:
            round_trip_ms = (time.perf_counter() - start) * 1000
            results.append({"i": i, "round_trip_ms": round(round_trip_ms, 2), "error": str(e)})

        if (i + 1) % 500 == 0 or (i + 1) == num_calls:
            print(f"  {i + 1:,}/{num_calls:,} done", file=sys.stderr)

        if delay > 0:
            time.sleep(delay)

    return results


def print_report(results: list[dict], num_calls: int):
    errors = [r for r in results if "error" in r]
    ok = [r for r in results if "error" not in r]

    print(f"\n{'='*65}")
    print(f"  BENCHMARK RESULTS — {len(ok):,} OK / {len(errors):,} errors of {num_calls:,}")
    print(f"{'='*65}\n")

    if errors:
        print(f"  First error: {errors[0].get('error', '?')}\n")

    if not ok:
        print("  No successful calls.")
        return {}

    fields = [
        ("lookup_ms", "Feature lookup (model)"),
        ("inference_ms", "Inference (model)"),
        ("total_ms", "Total model time"),
        ("round_trip_ms", "End-to-end round trip"),
    ]

    header = f"  {'Metric':<28s} {'p50':>8s} {'p75':>8s} {'p90':>8s} {'p95':>8s} {'p99':>8s}"
    print(header)
    print(f"  {'-'*68}")

    summary = {}
    for field, label in fields:
        vals = sorted(r[field] for r in ok if r.get(field) is not None)
        if not vals:
            continue
        p = {q: round(percentile(vals, q), 1) for q in [50, 75, 90, 95, 99]}
        summary[field] = p
        print(
            f"  {label:<28s} {p[50]:>7.1f}ms {p[75]:>7.1f}ms "
            f"{p[90]:>7.1f}ms {p[95]:>7.1f}ms {p[99]:>7.1f}ms"
        )

    overhead_vals = sorted(
        r["round_trip_ms"] - r["total_ms"]
        for r in ok
        if r.get("round_trip_ms") is not None and r.get("total_ms") is not None
    )
    if overhead_vals:
        p = {q: round(percentile(overhead_vals, q), 1) for q in [50, 75, 90, 95, 99]}
        summary["network_overhead_ms"] = p
        print(
            f"  {'Network overhead':<28s} {p[50]:>7.1f}ms {p[75]:>7.1f}ms "
            f"{p[90]:>7.1f}ms {p[95]:>7.1f}ms {p[99]:>7.1f}ms"
        )

    print()
    return summary


def main():
    parser = argparse.ArgumentParser(description="Benchmark fraud-detection endpoint")
    parser.add_argument("--calls", type=int, default=5000)
    parser.add_argument("--delay", type=float, default=0.05)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--output", type=str, default="/tmp/benchmark_results.json")
    parser.add_argument("--client-id", type=str, default=os.environ.get("CLIENT_ID"))
    parser.add_argument("--client-secret", type=str, default=os.environ.get("CLIENT_SECRET"))
    args = parser.parse_args()

    ws = build_client(args.client_id, args.client_secret)
    results = run_benchmark(ws, args.calls, args.delay, args.warmup)
    summary = print_report(results, args.calls)

    with open(args.output, "w") as f:
        json.dump({"summary": summary, "raw": results}, f, indent=2)
    print(f"  Full results → {args.output}\n")


if __name__ == "__main__":
    main()
