"""Verification of AOA webhook deliveries.

Each delivery carries ``AOA-Signature: t=<unix seconds>,v1=<hex>``, where
``v1`` is HMAC-SHA256 of ``f"{t}.{raw_body}"`` with the endpoint secret.
Always verify against the RAW body bytes, before parsing JSON.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import List, Optional, Tuple, Union

from .errors import WebhookSignatureError
from .types import WebhookEvent

SIGNATURE_HEADER = "AOA-Signature"
#: Same value on every retry of one delivery: deduplicate by it.
DELIVERY_ID_HEADER = "AOA-Delivery-Id"
EVENT_TYPE_HEADER = "AOA-Event-Type"
DEFAULT_TOLERANCE_SECONDS = 300


def _parse_header(header: str) -> Tuple[Optional[str], List[str]]:
    timestamp: Optional[str] = None
    signatures: List[str] = []
    for part in header.split(","):
        key, sep, value = part.partition("=")
        if not sep:
            continue
        key, value = key.strip(), value.strip()
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)
    return timestamp, signatures


def verify_webhook_signature(
    header: Optional[str],
    raw_body: Union[bytes, str],
    secret: str,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[float] = None,
) -> bool:
    """Return True when ``header`` is a fresh, valid signature of ``raw_body``."""
    if not header or not secret:
        return False
    timestamp, signatures = _parse_header(header)
    if not timestamp or not timestamp.isdigit() or not signatures:
        return False
    current = time.time() if now is None else now
    if abs(int(current) - int(timestamp)) > tolerance_seconds:
        return False

    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    expected = hmac.new(
        secret.encode("utf-8"), f"{timestamp}.".encode("utf-8") + body, hashlib.sha256
    ).hexdigest()
    # compare_digest is constant-time; check every v1 to allow secret rotation.
    return any(hmac.compare_digest(expected, signature) for signature in signatures)


def construct_webhook_event(
    raw_body: Union[bytes, str],
    header: Optional[str],
    secret: str,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[float] = None,
) -> WebhookEvent:
    """Verify the signature and parse the delivery; raise on a bad signature."""
    if not verify_webhook_signature(header, raw_body, secret, tolerance_seconds, now):
        raise WebhookSignatureError("Invalid AOA-Signature")
    text = raw_body.decode("utf-8") if isinstance(raw_body, bytes) else raw_body
    return json.loads(text)
