import uuid
import random
import time
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from databricks.sdk import WorkspaceClient

from .core import create_router, Dependencies
from .eventhub import send_event, EH_NAMESPACE, EH_TOPIC
from .postgres import get_profile
from .models import (
    VersionOut,
    TransactionIn,
    TransactionOut,
    TransactionStatus,
    FraudCheckLatency,
    UserProfileIn,
    UserProfileOut,
    EventHubMessageOut,
)

logger = logging.getLogger("retail-app.router")

router = create_router()

FRAUD_ENDPOINT_NAME = "fraud-detection-lakebase"

MERCHANTS = [
    "Global Retail Co.", "Metro Marketplace", "Summit Electronics",
    "Atlas Department Store", "Pacific Trading Ltd.",
]

CATEGORIES = [
    "Electronics", "Groceries", "Clothing", "Home & Garden",
    "Health & Beauty", "Sports & Outdoors",
]

US_COUNTRY_CODES = {"840", "US", "USA"}


def _format_credit_card(raw: str) -> str:
    digits = raw.replace(" ", "").replace("-", "")
    return " ".join(digits[i : i + 4] for i in range(0, len(digits), 4))


async def _check_fraud(
    ws: WorkspaceClient, txn: TransactionIn
) -> dict[str, Any]:
    payload = [
        {
            "user": "usr-001",
            "country": txn.country,
            "country_code": txn.country_code,
            "amount": txn.amount,
            "credit_card": _format_credit_card(txn.credit_card_number),
            "currency": txn.currency,
        }
    ]

    start = time.perf_counter()
    response = await asyncio.to_thread(
        ws.serving_endpoints.query,
        name=FRAUD_ENDPOINT_NAME,
        dataframe_records=payload,
    )
    model_call_ms = (time.perf_counter() - start) * 1000

    prediction = response.predictions[0]
    return {
        "fraud_probability": prediction["fraud_probability"],
        "fraud_flag": prediction["fraud_flag"],
        "model_call_ms": model_call_ms,
        "model_lookup_ms": prediction.get("lookup_ms"),
        "model_inference_ms": prediction.get("inference_ms"),
        "model_total_ms": prediction.get("total_ms"),
    }


@router.get("/version", response_model=VersionOut, operation_id="version")
async def version():
    return VersionOut.from_metadata()


@router.post("/transactions", response_model=TransactionOut, operation_id="createTransaction")
async def create_transaction(txn: TransactionIn, ws: Dependencies.Client):
    backend_start = time.perf_counter()
    txn_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    fraud_probability: float | None = None
    fraud_flag: int | None = None
    latency: FraudCheckLatency | None = None
    status = TransactionStatus.COMPLETED
    decline_reason: str | None = None

    if ws is not None:
        try:
            result = await _check_fraud(ws, txn)
            fraud_probability = result["fraud_probability"]
            fraud_flag = result["fraud_flag"]

            backend_total_ms = (time.perf_counter() - backend_start) * 1000
            latency = FraudCheckLatency(
                backend_total_ms=round(backend_total_ms, 2),
                model_call_ms=round(result["model_call_ms"], 2),
                model_lookup_ms=round(result["model_lookup_ms"], 2) if result["model_lookup_ms"] is not None else None,
                model_inference_ms=round(result["model_inference_ms"], 2) if result["model_inference_ms"] is not None else None,
                model_total_ms=round(result["model_total_ms"], 2) if result["model_total_ms"] is not None else None,
            )

            if fraud_flag == 1:
                status = TransactionStatus.DECLINED
                decline_reason = (
                    f"Fraud detected — probability {fraud_probability:.1%}. "
                    f"Transaction blocked by AI fraud detection model."
                )
        except Exception:
            logger.exception("Fraud detection endpoint call failed")

    return TransactionOut(
        id=txn_id,
        transaction_number=f"TXN-{now.strftime('%Y%m%d')}-{random.randint(1000, 9999)}",
        country=txn.country,
        country_code=txn.country_code,
        amount=txn.amount,
        credit_card_number=txn.credit_card_number,
        currency=txn.currency,
        status=status,
        merchant=random.choice(MERCHANTS),
        category=random.choice(CATEGORIES),
        decline_reason=decline_reason,
        fraud_probability=fraud_probability,
        fraud_flag=fraud_flag,
        latency=latency,
        created_at=now,
    )


@router.get("/profile", response_model=UserProfileOut, operation_id="getProfile")
async def get_profile_route():
    row = get_profile("usr-001")
    if row is None:
        return UserProfileOut(
            id="usr-001",
            full_name="John Doe",
            email="john.doe@databricks.com",
            phone="+1 (555) 234-5678",
            country_of_residence="United States",
            country_code="840",
            preferred_currency="USD",
            allow_international_transactions=False,
            daily_limit=5000,
            enable_notifications=True,
            two_factor_enabled=False,
            eventhub_status="disconnected",
            updated_at=datetime.now(timezone.utc),
        )

    return UserProfileOut(
        id=row["user_id"],
        full_name=row["full_name"],
        email=row["email"],
        phone=row.get("phone"),
        country_of_residence=row["country_of_residence"],
        country_code=row["country_code"],
        preferred_currency=row["preferred_currency"],
        allow_international_transactions=row["allow_international_transactions"],
        daily_limit=row["daily_limit"],
        enable_notifications=row["enable_notifications"],
        two_factor_enabled=row["two_factor_enabled"],
        eventhub_status="connected",
        updated_at=row["updated_at"],
    )


@router.post("/profile", response_model=EventHubMessageOut, operation_id="updateProfile")
async def update_profile(profile: UserProfileIn):
    """Encodes profile as JSON and publishes to EventHub topic."""
    now = datetime.now(timezone.utc)
    event_id = str(uuid.uuid4())
    partition_key = "usr-001"

    payload = {
        "event_id": event_id,
        "event_type": "profile_update",
        "user_id": "usr-001",
        "timestamp": now.isoformat(),
        "data": profile.model_dump(),
    }

    success = await send_event(payload, partition_key=partition_key)

    eh_status = "sent" if success else "failed"

    topic = f"{EH_NAMESPACE}/{EH_TOPIC}"
    return EventHubMessageOut(
        status=eh_status,
        message=f"Profile update {'published to' if success else 'failed to publish to'} EventHub",
        event_id=event_id,
        topic=topic,
        partition_key=partition_key,
        timestamp=now,
    )
