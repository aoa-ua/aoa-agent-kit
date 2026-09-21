"""Typed shapes of the AOA API, mirroring ``components.schemas`` of the spec.

These are ``TypedDict`` definitions for editors and type checkers; at runtime
every value is a plain ``dict``. Fields not listed as required by the spec
are optional (``total=False``).
"""

from __future__ import annotations

from typing import Dict, List, Literal, Optional, TypedDict

WebhookEventType = Literal[
    "order.paid",
    "order.failed",
    "order.refunded",
    "event.cancelled",
    "event.updated",
    "attendee.registered",
    "attendee.checked_in",
]

WEBHOOK_EVENT_TYPES = (
    "order.paid",
    "order.failed",
    "order.refunded",
    "event.cancelled",
    "event.updated",
    "attendee.registered",
    "attendee.checked_in",
)

OrderStatus = Literal["PENDING", "PROCESSING", "SUCCESS", "FAILED", "EXPIRED", "REFUNDED"]

#: Statuses after which polling ``get_order`` can stop.
TERMINAL_ORDER_STATUSES = frozenset({"SUCCESS", "FAILED", "EXPIRED", "REFUNDED"})


class _LocationRequired(TypedDict):
    id: str
    name: str
    url: str
    reservationsEnabled: bool
    maxGuests: int


class Location(_LocationRequired, total=False):
    address: Optional[str]
    city: Optional[str]
    phone: Optional[str]
    imageUrl: Optional[str]
    openingHours: Optional[str]
    latitude: Optional[float]
    longitude: Optional[float]


class TableSlot(TypedDict, total=False):
    value: str
    label: str
    available: bool


class TableAvailability(TypedDict, total=False):
    locationId: str
    date: str
    reason: Literal["ok", "disabled", "closed", "no_slots"]
    maxGuests: int
    slots: List[TableSlot]


class EventSummary(TypedDict, total=False):
    id: str
    url: str
    title: str
    startAt: Optional[str]
    endAt: Optional[str]
    imageUrl: Optional[str]
    eventType: Optional[str]
    status: Optional[str]
    city: Optional[str]
    venue: Optional[str]


class TicketType(TypedDict, total=False):
    id: str
    name: str
    priceMinor: int
    priceDecimal: str
    currency: str
    isFree: bool
    capacity: Optional[int]
    sold: int
    remaining: Optional[int]
    salesStart: Optional[str]
    salesEnd: Optional[str]
    status: Literal["on_sale", "sold_out", "sales_not_started", "sales_ended"]


class RefundPolicy(TypedDict, total=False):
    refundsEnabled: bool
    refundDeadlineHours: Optional[int]


class EventDetail(TypedDict, total=False):
    id: str
    url: str
    title: str
    description: Optional[str]
    imageUrl: Optional[str]
    startAt: Optional[str]
    endAt: Optional[str]
    allDay: bool
    eventType: Optional[str]
    status: Optional[str]
    attendanceMode: str
    capacity: Optional[int]
    location: Optional[Dict[str, object]]
    organizer: Dict[str, object]
    refundPolicy: RefundPolicy
    ticketTypes: List[TicketType]


class EventAvailability(TypedDict):
    eventId: str
    #: ``{ticketTypeId: remaining}``; empty when capacity is unlimited.
    ticketTypes: Dict[str, int]
    checkedAt: str


class TicketSelection(TypedDict):
    ticketTypeId: str
    #: 1..20 per ticket type.
    quantity: int


class _GuestRequired(TypedDict):
    name: str
    phone: str


class GuestContact(_GuestRequired, total=False):
    email: str


class _BuyerRequired(TypedDict):
    email: str
    name: str


class TicketBuyer(_BuyerRequired, total=False):
    phone: str


class _TableReservationRequired(TypedDict):
    reservationId: str
    status: str
    locationId: str
    date: str
    time: str
    partySize: int


class TableReservation(_TableReservationRequired, total=False):
    locationName: Optional[str]


class _TicketReservationRequired(TypedDict):
    reservationId: str
    eventId: str
    expiresAt: str


class TicketReservation(_TicketReservationRequired, total=False):
    remaining: Dict[str, int]


class _CheckoutRequired(TypedDict):
    paymentId: str
    paymentUrl: str


class Checkout(_CheckoutRequired, total=False):
    #: Only with ``respond_async=True`` (HTTP 202): ``"PENDING"``.
    status: str
    #: Only with ``respond_async=True``: URL of ``GET /orders/{paymentId}``.
    statusUrl: str


class PageMeta(TypedDict, total=False):
    count: int
    limit: int
    #: Pass as ``cursor`` for the next page; ``None`` on the last page.
    nextCursor: Optional[str]
    hasMore: bool


class _BatchOperationRequired(TypedDict):
    #: Path relative to /api/v1 with its query, e.g. ``/events/AB12CD34``.
    path: str


class BatchOperation(_BatchOperationRequired, total=False):
    #: Your id, echoed in the result (up to 64 chars).
    id: str
    #: Only ``"GET"`` is allowed.
    method: Literal["GET"]


class BatchResult(TypedDict):
    id: str
    #: HTTP status of this operation.
    status: int
    #: ``{"data": ...}`` or ``{"error": ...}`` of this operation.
    body: object


class _OrderRequired(TypedDict):
    paymentId: str
    eventId: str
    status: OrderStatus
    amountMinor: int
    currency: str
    createdAt: str


class Order(_OrderRequired, total=False):
    amountDecimal: str
    attendeeId: Optional[str]
    failureReason: Optional[str]
    paidAt: Optional[str]


class _WebhookEndpointRequired(TypedDict):
    id: str
    url: str
    events: List[str]
    isActive: bool


class WebhookEndpoint(_WebhookEndpointRequired, total=False):
    secretPrefix: str
    failureCount: int
    disabledAt: Optional[str]
    lastSuccessAt: Optional[str]
    createdAt: str


class WebhookEndpointCreated(TypedDict):
    id: str
    url: str
    events: List[str]
    #: Shown ONCE: verifies ``AOA-Signature``.
    secret: str
    createdAt: str


class WebhookEndpointUpdated(_WebhookEndpointRequired, total=False):
    failureCount: int
    disabledAt: Optional[str]


class WebhookEvent(TypedDict):
    #: Equals the ``AOA-Delivery-Id`` header; the same on every retry.
    id: str
    type: WebhookEventType
    createdAt: str
    data: Dict[str, object]
