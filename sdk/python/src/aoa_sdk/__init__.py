"""Official Python SDK for the AOA public API (https://aoa.com.ua/docs).

>>> from aoa_sdk import AoaClient
>>> client = AoaClient()  # reads work without a key
>>> events = client.search_events(city="Київ", limit=5).data
"""

from ._version import __version__
from .client import DEFAULT_BASE_URL, AoaClient, ApiResponse
from .errors import AoaApiError, AoaConnectionError, AoaError, WebhookSignatureError
from .rate_limit import RateLimitInfo, parse_rate_limit
from .transport import HttpRequest, HttpResponse, Transport, urllib_transport
from .types import TERMINAL_ORDER_STATUSES, WEBHOOK_EVENT_TYPES
from .webhooks import (
    DEFAULT_TOLERANCE_SECONDS,
    DELIVERY_ID_HEADER,
    EVENT_TYPE_HEADER,
    SIGNATURE_HEADER,
    construct_webhook_event,
    verify_webhook_signature,
)

__all__ = [
    "__version__",
    "AoaApiError",
    "AoaClient",
    "AoaConnectionError",
    "AoaError",
    "ApiResponse",
    "DEFAULT_BASE_URL",
    "DEFAULT_TOLERANCE_SECONDS",
    "DELIVERY_ID_HEADER",
    "EVENT_TYPE_HEADER",
    "HttpRequest",
    "HttpResponse",
    "RateLimitInfo",
    "SIGNATURE_HEADER",
    "TERMINAL_ORDER_STATUSES",
    "Transport",
    "WEBHOOK_EVENT_TYPES",
    "WebhookSignatureError",
    "construct_webhook_event",
    "parse_rate_limit",
    "urllib_transport",
    "verify_webhook_signature",
]
