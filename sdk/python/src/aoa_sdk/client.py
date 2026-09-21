"""Synchronous client for the AOA public API (https://aoa.com.ua/api/v1).

Every public method maps to one operationId of the OpenAPI spec
(https://aoa.com.ua/openapi.json): ``search_events`` is ``searchEvents`` and
so on. Method keyword arguments are snake_case; nested dictionaries
(``guest``, ``buyer``, ``tickets``) use the API field names as they are.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import (
    Any,
    Callable,
    Dict,
    Generic,
    Iterator,
    List,
    Mapping,
    Optional,
    Sequence,
    TypeVar,
)
from urllib.parse import quote, urlencode

from ._version import __version__
from .errors import AoaApiError, error_from_response
from .rate_limit import RateLimitInfo, parse_rate_limit
from .transport import HttpRequest, Transport, urllib_transport
from .types import (
    BatchOperation,
    BatchResult,
    Checkout,
    EventAvailability,
    EventDetail,
    EventSummary,
    GuestContact,
    Location,
    Order,
    TableAvailability,
    TableReservation,
    TicketBuyer,
    TicketReservation,
    TicketSelection,
    TicketType,
    WebhookEndpoint,
    WebhookEndpointCreated,
    WebhookEndpointUpdated,
    WebhookEventType,
)

DEFAULT_BASE_URL = "https://aoa.com.ua/api/v1"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRY_DELAY = 60.0

T = TypeVar("T")


@dataclass(frozen=True)
class ApiResponse(Generic[T]):
    """Successful response: the ``data`` of the envelope plus transport details."""

    data: T
    meta: Optional[Dict[str, Any]]
    status: int
    headers: Mapping[str, str] = field(repr=False)
    rate_limit: Optional[RateLimitInfo] = None


def _drop_none(values: Mapping[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def _query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class AoaClient:
    """Client for the AOA API.

    ``api_key`` (``aoa_live_...``) is needed for write operations and raises
    the read limit from 60 to 600 requests per minute. It defaults to the
    ``AOA_API_KEY`` environment variable. Keep it on the server.

    ``max_retries`` retries responses with status 429 after ``Retry-After``
    (opt-in, default 0). A ``Retry-After`` longer than ``max_retry_delay``
    seconds is raised instead of waited for.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = 0,
        max_retry_delay: float = DEFAULT_MAX_RETRY_DELAY,
        agent_provider: Optional[str] = None,
        user_agent: Optional[str] = None,
        headers: Optional[Mapping[str, str]] = None,
        transport: Optional[Transport] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.api_key = api_key if api_key is not None else os.environ.get("AOA_API_KEY") or None
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.max_retry_delay = max_retry_delay
        self.agent_provider = agent_provider
        self.user_agent = " ".join(filter(None, [f"aoa-sdk-python/{__version__}", user_agent]))
        self.default_headers = dict(headers or {})
        self._transport: Transport = transport or urllib_transport
        self._sleep = sleep
        self._rate_limit: Optional[RateLimitInfo] = None

    @property
    def rate_limit(self) -> Optional[RateLimitInfo]:
        """Rate-limit state from the most recent response."""
        return self._rate_limit

    # ── Generic request ──────────────────────────────────────────────────

    def request(
        self,
        method: str,
        path: str,
        *,
        path_params: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        body: Any = None,
        requires_auth: bool = False,
        idempotency_key: Optional[str] = None,
        generate_idempotency_key: bool = False,
        headers: Optional[Mapping[str, str]] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ) -> ApiResponse[Any]:
        """Call any endpoint. ``path`` uses the spec form, e.g. ``/events/{eventId}``."""
        if requires_auth and not self.api_key:
            raise ValueError(
                f"{method} {path} needs a partner API key: pass api_key to AoaClient "
                "or set AOA_API_KEY."
            )

        resolved = path
        for name, value in (path_params or {}).items():
            if value is None or value == "":
                raise ValueError(f'"{name}" is required')
            resolved = resolved.replace("{" + name + "}", quote(str(value), safe=""))

        url = self.base_url + resolved
        pairs = []
        for name, value in _drop_none(query or {}).items():
            values = value if isinstance(value, (list, tuple)) else [value]
            pairs.extend((name, _query_value(item)) for item in values)
        if pairs:
            url += "?" + urlencode(pairs)

        request_headers: Dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if self.api_key:
            request_headers["Authorization"] = f"Bearer {self.api_key}"
        if self.agent_provider:
            request_headers["X-Agent-Provider"] = self.agent_provider
        key = idempotency_key or (str(uuid.uuid4()) if generate_idempotency_key else None)
        if key:
            request_headers["Idempotency-Key"] = key
        payload: Optional[bytes] = None
        if body is not None:
            request_headers["Content-Type"] = "application/json"
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request_headers.update(self.default_headers)
        request_headers.update(headers or {})

        retries = self.max_retries if max_retries is None else max_retries
        attempt = 0
        while True:
            response = self._transport(
                HttpRequest(
                    method=method,
                    url=url,
                    headers=request_headers,
                    body=payload,
                    timeout=self.timeout if timeout is None else timeout,
                )
            )
            rate_limit = parse_rate_limit(response.headers)
            if rate_limit is not None:
                self._rate_limit = rate_limit
            parsed = self._parse(response.body)

            if 200 <= response.status < 300:
                if not isinstance(parsed, dict):
                    raise AoaApiError(
                        status=response.status,
                        code="invalid_response",
                        message="Expected a JSON object from the AOA API",
                        rate_limit=rate_limit,
                        body=parsed,
                    )
                return ApiResponse(
                    data=parsed.get("data"),
                    meta=parsed.get("meta"),
                    status=response.status,
                    headers=response.headers,
                    rate_limit=rate_limit,
                )

            if response.status == 429 and attempt < retries:
                delay = self._retry_delay(rate_limit)
                if delay <= self.max_retry_delay:
                    self._sleep(delay)
                    attempt += 1
                    continue
            raise error_from_response(response.status, response.reason, parsed, rate_limit)

    def paginate(self, method: Callable[..., ApiResponse[Any]], **params: Any) -> Iterator[Any]:
        """Yield every item of a list method, following ``meta.nextCursor``.

        ``for event in client.paginate(client.search_events, city="Київ"): ...``
        Stops after the first page when the server returns no cursor.
        """
        cursor = params.pop("cursor", None)
        while True:
            page = method(**params, cursor=cursor) if cursor else method(**params)
            for item in page.data or []:
                yield item
            next_cursor = (page.meta or {}).get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor or next_cursor == cursor:
                return
            cursor = next_cursor

    @staticmethod
    def _parse(body: bytes) -> Any:
        if not body:
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return body.decode("utf-8", errors="replace")

    @staticmethod
    def _retry_delay(rate_limit: Optional[RateLimitInfo]) -> float:
        if rate_limit is not None and rate_limit.retry_after_seconds is not None:
            return float(rate_limit.retry_after_seconds)
        if rate_limit is not None and rate_limit.reset_seconds is not None:
            return float(rate_limit.reset_seconds)
        return 1.0

    # ── Locations (no key needed) ────────────────────────────────────────

    def search_locations(
        self,
        *,
        query: Optional[str] = None,
        city: Optional[str] = None,
        bookable: Optional[bool] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> ApiResponse[List[Location]]:
        """searchLocations: ``GET /locations``. Venues where a table can be booked.

        ``bookable`` defaults to true on the server; ``limit`` is 1..20 (10).
        """
        return self.request(
            "GET",
            "/locations",
            query={"query": query, "city": city, "bookable": bookable, "limit": limit, "cursor": cursor},
        )

    def get_location(self, location_id: str) -> ApiResponse[Location]:
        """getLocation: ``GET /locations/{locationId}``."""
        return self.request(
            "GET", "/locations/{locationId}", path_params={"locationId": location_id}
        )

    def get_table_availability(self, location_id: str, date: str) -> ApiResponse[TableAvailability]:
        """getTableAvailability: ``GET /locations/{locationId}/availability``.

        ``date`` is ``YYYY-MM-DD``. ``data.reason`` is ok, disabled, closed or no_slots.
        """
        return self.request(
            "GET",
            "/locations/{locationId}/availability",
            path_params={"locationId": location_id},
            query={"date": date},
        )

    # ── Events (no key needed) ───────────────────────────────────────────

    def search_events(
        self,
        *,
        category: Optional[str] = None,
        city: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> ApiResponse[List[EventSummary]]:
        """searchEvents: ``GET /events``. Published upcoming public events.

        ``category`` is a slug (workshop, lecture, party, ...); ``city`` is
        case-insensitive; ``limit`` is 1..100 (50).
        """
        return self.request(
            "GET",
            "/events",
            query={"category": category, "city": city, "limit": limit, "cursor": cursor},
        )

    def get_event(self, event_id: str) -> ApiResponse[EventDetail]:
        """getEvent: ``GET /events/{eventId}``. ``event_id`` is the shortId or full id."""
        return self.request("GET", "/events/{eventId}", path_params={"eventId": event_id})

    def get_event_ticket_types(self, event_id: str) -> ApiResponse[List[TicketType]]:
        """getEventTicketTypes: ``GET /events/{eventId}/ticket-types``."""
        return self.request(
            "GET", "/events/{eventId}/ticket-types", path_params={"eventId": event_id}
        )

    def get_event_availability(self, event_id: str) -> ApiResponse[EventAvailability]:
        """getEventAvailability: ``GET /events/{eventId}/availability``. Live remaining per ticket type."""
        return self.request(
            "GET", "/events/{eventId}/availability", path_params={"eventId": event_id}
        )

    # ── Commerce (partner API key) ───────────────────────────────────────

    def create_table_reservation(
        self,
        *,
        location_id: str,
        date: str,
        time: str,
        party_size: int,
        guest: GuestContact,
        confirmed_by_user: bool,
        comment: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> ApiResponse[TableReservation]:
        """createTableReservation: ``POST /table-reservations`` (scope reservations:write).

        Call only after the person saw venue, date, time, party size and
        contacts and explicitly confirmed; then pass ``confirmed_by_user=True``.
        ``guest`` is ``{"name", "phone", "email"?}`` typed by the person, never
        invented. The venue still has to confirm the booking.
        """
        if confirmed_by_user is not True:
            raise ValueError(
                "confirmed_by_user must be True: show the booking details to the "
                "person and get an explicit yes first"
            )
        return self.request(
            "POST",
            "/table-reservations",
            body=_drop_none(
                {
                    "locationId": location_id,
                    "date": date,
                    "time": time,
                    "partySize": party_size,
                    "guest": guest,
                    "comment": comment,
                    "confirmedByUser": confirmed_by_user,
                }
            ),
            requires_auth=True,
            idempotency_key=idempotency_key,
            generate_idempotency_key=True,
        )

    def create_ticket_reservation(
        self, *, event_id: str, tickets: Sequence[TicketSelection]
    ) -> ApiResponse[TicketReservation]:
        """createTicketReservation: ``POST /reservations`` (scope reservations:write).

        Holds tickets for 15 minutes. All or nothing; there is no cancel call,
        an unused hold expires on its own.
        """
        return self.request(
            "POST",
            "/reservations",
            body={"eventId": event_id, "tickets": list(tickets)},
            requires_auth=True,
        )

    def create_ticket_checkout(
        self,
        *,
        event_id: str,
        tickets: Sequence[TicketSelection],
        buyer: TicketBuyer,
        coupon_code: Optional[str] = None,
        referral_code: Optional[str] = None,
        reservation_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        respond_async: bool = False,
    ) -> ApiResponse[Checkout]:
        """createTicketCheckout: ``POST /checkout`` (scope checkout:write).

        Returns ``paymentUrl`` for the person and ``paymentId`` to poll with
        :meth:`get_order`. Pass an ``idempotency_key`` tied to your order so a
        retry cannot create a second payment; one is generated otherwise.
        ``respond_async=True`` sends ``Prefer: respond-async``: the API answers
        202 with ``status`` and ``statusUrl`` in ``data`` and ``Location`` and
        ``Retry-After`` (polling interval) headers.
        """
        return self.request(
            "POST",
            "/checkout",
            body=_drop_none(
                {
                    "eventId": event_id,
                    "tickets": list(tickets),
                    "buyer": buyer,
                    "couponCode": coupon_code,
                    "referralCode": referral_code,
                    "reservationId": reservation_id,
                }
            ),
            requires_auth=True,
            idempotency_key=idempotency_key,
            generate_idempotency_key=True,
            headers={"Prefer": "respond-async"} if respond_async else None,
        )

    def get_order(self, payment_id: str) -> ApiResponse[Order]:
        """getOrder: ``GET /orders/{paymentId}`` (scope checkout:write).

        Poll every 5 to 10 seconds; stop on SUCCESS, FAILED, EXPIRED or REFUNDED.
        """
        return self.request(
            "GET",
            "/orders/{paymentId}",
            path_params={"paymentId": payment_id},
            requires_auth=True,
        )

    # ── Batch (no key needed) ────────────────────────────────────────────

    def batch_operations(self, operations: Sequence[BatchOperation]) -> ApiResponse[List[BatchResult]]:
        """batchOperations: ``POST /batch``. Up to 20 read (GET) operations in one request.

        ``operations`` are ``{"path": "/events/AB12CD34", "id"?: ...}`` with
        paths relative to /api/v1. Results come back in the same order, each
        with its own ``status`` and ``body``; every operation counts against
        the rate limit like a separate request.
        """
        return self.request("POST", "/batch", body={"operations": list(operations)})

    # ── Webhooks (partner API key, scope webhooks:write) ─────────────────

    def list_webhooks(self) -> ApiResponse[List[WebhookEndpoint]]:
        """listWebhooks: ``GET /webhooks``."""
        return self.request("GET", "/webhooks", requires_auth=True)

    def create_webhook(
        self, *, url: str, events: Sequence[WebhookEventType]
    ) -> ApiResponse[WebhookEndpointCreated]:
        """createWebhook: ``POST /webhooks``. ``data.secret`` is shown ONCE: store it."""
        return self.request(
            "POST",
            "/webhooks",
            body={"url": url, "events": list(events)},
            requires_auth=True,
        )

    def update_webhook(
        self,
        endpoint_id: str,
        *,
        is_active: Optional[bool] = None,
        events: Optional[Sequence[WebhookEventType]] = None,
    ) -> ApiResponse[WebhookEndpointUpdated]:
        """updateWebhook: ``PATCH /webhooks/{endpointId}``.

        ``is_active=True`` re-enables an endpoint that was switched off after
        repeated failures and resets its failure counter.
        """
        return self.request(
            "PATCH",
            "/webhooks/{endpointId}",
            path_params={"endpointId": endpoint_id},
            body=_drop_none(
                {
                    "isActive": is_active,
                    "events": list(events) if events is not None else None,
                }
            ),
            requires_auth=True,
        )

    def delete_webhook(self, endpoint_id: str) -> ApiResponse[Dict[str, bool]]:
        """deleteWebhook: ``DELETE /webhooks/{endpointId}``."""
        return self.request(
            "DELETE",
            "/webhooks/{endpointId}",
            path_params={"endpointId": endpoint_id},
            requires_auth=True,
        )
