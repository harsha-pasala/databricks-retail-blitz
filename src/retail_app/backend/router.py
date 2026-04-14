import uuid
import random
import time
import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from databricks.sdk import WorkspaceClient

from .core import create_router, Dependencies
from .postgres import get_profile, list_users, update_profile
from .models import (
    VersionOut,
    TransactionIn,
    TransactionOut,
    TransactionStatus,
    FraudCheckLatency,
    UserSummary,
    UserProfileIn,
    UserProfileOut,
    ProfileSaveOut,
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


def _format_credit_card(raw: str) -> str:
    digits = raw.replace(" ", "").replace("-", "")
    return " ".join(digits[i : i + 4] for i in range(0, len(digits), 4))


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

    predictions = response.predictions or []
    if not predictions:
        raise ValueError("Model serving endpoint returned no predictions")

    prediction = predictions[0]
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


@router.get("/users", response_model=list[UserSummary], operation_id="listUsers")
async def list_users_route():
    rows = list_users()
    return [
        UserSummary(
            user_id=r["user_id"],
            full_name=r["full_name"],
            email=r["email"],
            credit_card_number=r.get("credit_card_number"),
        )
        for r in rows
    ]


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

    # --- Always call the fraud model first (for latency telemetry) ---
    if ws is not None:
        try:
            result = await _check_fraud(ws, txn)
            fraud_probability = result["fraud_probability"]
            fraud_flag = result["fraud_flag"]

            backend_total_ms = (time.perf_counter() - backend_start) * 1000
            latency = FraudCheckLatency(
                backend_total_ms=round(backend_total_ms, 2),
                model_call_ms=round(result["model_call_ms"], 2),
                model_lookup_ms=(
                    round(result["model_lookup_ms"], 2)
                    if result["model_lookup_ms"] is not None
                    else None
                ),
                model_inference_ms=(
                    round(result["model_inference_ms"], 2)
                    if result["model_inference_ms"] is not None
                    else None
                ),
                model_total_ms=(
                    round(result["model_total_ms"], 2)
                    if result["model_total_ms"] is not None
                    else None
                ),
            )

            if fraud_flag == 1:
                status = TransactionStatus.DECLINED
                decline_reason = (
                    f"Fraud detected — probability {fraud_probability:.1%}. "
                    f"Transaction blocked by AI fraud detection model."
                )
        except Exception:
            logger.exception("Fraud detection endpoint call failed")

    # --- Business rules: check user profile (overrides model approval) ---
    biz_start = time.perf_counter()
    profile = get_profile(txn.user_id)

    if profile is not None:
        user_country = profile.get("country_of_residence", "")
        daily_limit = float(profile.get("daily_limit", 50000))
        allow_intl = profile.get("allow_international_transactions", True)

        # Rule 1: amount exceeds daily limit
        if txn.amount > daily_limit:
            status = TransactionStatus.DECLINED
            decline_reason = (
                f"Amount ${txn.amount:,.0f} exceeds your daily limit of "
                f"${daily_limit:,.0f}. Update your profile to increase it."
            )

        # Rule 2: international transaction not allowed
        if (
            not allow_intl
            and txn.country_code != user_country
        ):
            status = TransactionStatus.DECLINED
            decline_reason = (
                f"International transactions are disabled on your account. "
                f"Transaction country ({txn.country_code}) differs from your "
                f"country of residence ({user_country})."
            )

    business_logic_ms = round((time.perf_counter() - biz_start) * 1000, 2)

    # Attach business_logic_ms to latency (create one if model wasn't called)
    if latency is not None:
        latency.business_logic_ms = business_logic_ms
    else:
        backend_total_ms = (time.perf_counter() - backend_start) * 1000
        latency = FraudCheckLatency(
            backend_total_ms=round(backend_total_ms, 2),
            model_call_ms=0,
            business_logic_ms=business_logic_ms,
        )

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
async def get_profile_route(user_id: str = "usr-001"):
    row = get_profile(user_id)
    if row is None:
        return UserProfileOut(
            user_id=user_id,
            full_name="Unknown User",
            email="",
            card_bin="000000",
            credit_card_number="0000000000000000",
            country_of_residence="US",
            preferred_currency="USD",
            allow_international_transactions=True,
            daily_limit=5000,
        )

    return UserProfileOut(
        user_id=row["user_id"],
        full_name=row["full_name"],
        email=row["email"],
        phone=row.get("phone"),
        card_bin=row["card_bin"],
        credit_card_number=row.get("credit_card_number", ""),
        card_network=row.get("card_network"),
        country_of_residence=row.get("country_of_residence", "US"),
        preferred_currency=row.get("preferred_currency", "USD"),
        allow_international_transactions=row.get("allow_international_transactions", True),
        daily_limit=float(row.get("daily_limit", 5000)),
    )


@router.post("/profile", response_model=ProfileSaveOut, operation_id="updateProfile")
async def update_profile_route(profile: UserProfileIn):
    """Write profile changes directly to customer_features in Postgres."""
    data = profile.model_dump(exclude={"user_id"})
    success = update_profile(profile.user_id, data)

    return ProfileSaveOut(
        status="saved" if success else "failed",
        message=(
            "Profile saved to database"
            if success
            else "Failed to save profile"
        ),
        user_id=profile.user_id,
    )
