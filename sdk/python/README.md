# AOA SDK for Python

Official client for the [AOA (Act of Attraction)](https://aoa.com.ua/what-is-aoa) public API: venues and
table bookings, events and tickets, checkout, orders and webhooks in Ukraine.

- One method per `operationId` of the [OpenAPI spec](https://aoa.com.ua/openapi.json),
  in snake_case: `searchEvents` is `search_events`.
- Standard library only (`urllib`), Python 3.9+, typed (`py.typed`,
  `TypedDict` models).
- Automatic `Idempotency-Key` for table bookings and checkout, opt-in `429`
  retries honouring `Retry-After`, rate-limit state, cursor pagination,
  webhook signature verification.

```bash
pip install aoa-sdk
```

## Quick start

```python
from aoa_sdk import AoaClient

# Reads need no key. The key (aoa_live_...) is needed for writes and raises
# read limits from 60 to 600 requests per minute. Defaults to AOA_API_KEY.
client = AoaClient()

venues = client.search_locations(city="Київ", limit=5).data
day = client.get_table_availability(venues[0]["id"], "2026-10-03").data
free = [slot["value"] for slot in day.get("slots", []) if slot["available"]]
```

### Book a table (after the person confirmed)

```python
booking = client.create_table_reservation(
    location_id=venues[0]["id"],
    date="2026-10-03",
    time="19:00",
    party_size=2,
    guest={"name": guest_typed_name, "phone": guest_typed_phone},  # typed by the person
    confirmed_by_user=True,  # only after an explicit yes
    idempotency_key=f"booking-{cart_id}",  # generated when omitted
).data
# booking["status"]: pending until the venue confirms
```

Keyword arguments are snake_case; nested dictionaries (`guest`, `buyer`,
`tickets`) use the API field names.

### Sell tickets

```python
checkout = client.create_ticket_checkout(
    event_id="a1b2c3",
    tickets=[{"ticketTypeId": "tt_…", "quantity": 2}],
    buyer={"email": buyer_email, "name": buyer_name},
    idempotency_key=f"order-{order_id}",
).data
# Send the person to checkout["paymentUrl"], then poll:
order = client.get_order(checkout["paymentId"]).data
```

### Errors, limits, retries

```python
from aoa_sdk import AoaApiError, AoaClient

client = AoaClient(max_retries=2)  # retry 429 after Retry-After

try:
    client.get_event("missing")
except AoaApiError as error:
    error.status     # 404
    error.code       # "not_found" (branch on this, not on message)
    error.hint       # what to do next, when known
    error.retryable  # True for rate_limited and internal_error

client.rate_limit  # RateLimitInfo of the last response
```

### Pagination

```python
for event in client.paginate(client.search_events, city="Львів"):
    print(event["title"], event["url"])
```

### Several reads in one request

```python
results = client.batch_operations(
    [
        {"id": "first", "path": "/events/AB12CD34/availability"},
        {"id": "second", "path": "/events/EF56GH78/availability"},
    ]
).data
# results[i]: {"id", "status", "body"}, in the same order; up to 20 operations
```

`create_ticket_checkout(..., respond_async=True)` sends `Prefer: respond-async`
and gets `202` with `data["statusUrl"]`.

### Webhooks

```python
from aoa_sdk import WebhookSignatureError, construct_webhook_event

# Flask
@app.post("/hooks/aoa")
def aoa_webhook():
    try:
        event = construct_webhook_event(
            request.get_data(),  # raw bytes, before any JSON parsing
            request.headers.get("AOA-Signature"),
            os.environ["AOA_WEBHOOK_SECRET"],
        )
    except WebhookSignatureError:
        return "", 401
    queue.put(event)  # deduplicate by event["id"] (= AOA-Delivery-Id)
    return "", 200
```

### Custom transport

`AoaClient(transport=...)` accepts any callable `(HttpRequest) -> HttpResponse`:
use it for tests, proxies or instrumentation. The default transport does not
follow redirects, so the API key never leaves the configured host.

## Development

```bash
PYTHONPATH=src python -m unittest discover -s tests
python -m build
```

## Links

- Docs: https://aoa.com.ua/docs
- Repository: https://github.com/aoa-ua/aoa-agent-kit
- License: MIT
