from __future__ import annotations

import json
import logging
import asyncio
import os
from typing import Any
from functools import partial

from confluent_kafka import Producer

logger = logging.getLogger("retail-app.eventhub")

EH_NAMESPACE = "dlt-eventhub"
EH_TOPIC = "user-profile-updates"

EH_CONNECTION_STRING = os.getenv("EVENTHUB_CONNECTION_STRING")

_producer: Producer | None = None


def _get_producer() -> Producer:
    global _producer
    if _producer is None:
        if not EH_CONNECTION_STRING:
            raise ValueError("EVENTHUB_CONNECTION_STRING is not configured")
        _producer = Producer({
            "bootstrap.servers": f"{EH_NAMESPACE}.servicebus.windows.net:9093",
            "security.protocol": "SASL_SSL",
            "sasl.mechanism": "PLAIN",
            "sasl.username": "$ConnectionString",
            "sasl.password": EH_CONNECTION_STRING,
            "client.id": "retail-app",
            "message.timeout.ms": 15000,
        })
    return _producer


async def send_event(payload: dict[str, Any], partition_key: str) -> bool:
    """JSON-encode the payload and publish to the EventHub Kafka topic.
    Returns True on success, False on failure."""
    loop = asyncio.get_running_loop()
    result: dict[str, Any] = {"success": False, "error": None}

    def on_delivery(err, msg):  # type: ignore[no-untyped-def]
        if err:
            result["error"] = str(err)
        else:
            result["success"] = True
            logger.info(
                "Event delivered to %s/%s [%d] @ offset %d",
                EH_NAMESPACE, EH_TOPIC, msg.partition(), msg.offset(),
            )

    try:
        producer = _get_producer()
        encoded = json.dumps(payload, default=str).encode("utf-8")
        producer.produce(
            EH_TOPIC,
            value=encoded,
            key=partition_key.encode("utf-8"),
            callback=on_delivery,
        )
        await loop.run_in_executor(None, partial(producer.flush, 15))

        if not result["success"]:
            logger.error("EventHub delivery failed: %s", result["error"])
        return result["success"]
    except Exception as e:
        logger.error("Failed to send event to EventHub: %s", e)
        return False
