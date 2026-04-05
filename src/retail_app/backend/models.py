from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional
from enum import Enum

from .. import __version__


class VersionOut(BaseModel):
    version: str

    @classmethod
    def from_metadata(cls):
        return cls(version=__version__)


class TransactionStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    DECLINED = "declined"


class TransactionIn(BaseModel):
    user_id: str
    country: str
    country_code: str  # 2-letter ISO
    amount: float = Field(ge=10, le=10000)
    credit_card_number: str
    currency: str = "USD"


class FraudCheckLatency(BaseModel):
    backend_total_ms: float
    model_call_ms: float
    model_lookup_ms: Optional[float] = None
    model_inference_ms: Optional[float] = None
    model_total_ms: Optional[float] = None
    business_logic_ms: Optional[float] = None


class TransactionOut(BaseModel):
    id: str
    transaction_number: str
    country: str
    country_code: str
    amount: float
    credit_card_number: str
    currency: str
    status: TransactionStatus
    merchant: str
    category: str
    decline_reason: Optional[str] = None
    fraud_probability: Optional[float] = None
    fraud_flag: Optional[int] = None
    latency: Optional[FraudCheckLatency] = None
    created_at: datetime


class UserSummary(BaseModel):
    user_id: str
    full_name: str
    email: str
    credit_card_number: Optional[str] = None


class UserProfileIn(BaseModel):
    user_id: str
    full_name: str
    email: str
    phone: Optional[str] = None
    country_of_residence: str  # 2-letter ISO code
    preferred_currency: str = "USD"
    allow_international_transactions: bool = True
    daily_limit: float = Field(ge=100, le=50000, default=5000)
    enable_notifications: bool = True
    two_factor_enabled: bool = False


class UserProfileOut(BaseModel):
    user_id: str
    full_name: str
    email: str
    phone: Optional[str] = None
    card_bin: str
    credit_card_number: str
    card_network: Optional[str] = None
    country_of_residence: str
    preferred_currency: str
    allow_international_transactions: bool
    daily_limit: float
    enable_notifications: bool
    two_factor_enabled: bool


class ProfileSaveOut(BaseModel):
    status: str
    message: str
    user_id: str


class EventHubMessageOut(BaseModel):
    status: str
    message: str
    event_id: str
    topic: str
    partition_key: str
    timestamp: datetime
