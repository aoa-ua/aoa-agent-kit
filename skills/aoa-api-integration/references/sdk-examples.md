# SDK examples

The same flow in the three official SDKs: find an event, check stock, create
a checkout after the person confirmed, poll the order.

## TypeScript (`@aoa-ua/sdk`)

```ts
import { AoaApiError, createAoaClient } from '@aoa-ua/sdk';

const aoa = createAoaClient({
  apiKey: process.env.AOA_API_KEY, // optional for reads
  maxRetries: 2,                   // retry 429 after Retry-After (opt-in)
});

const { data: events } = await aoa.searchEvents({ city: 'Київ', limit: 10 });
const { data: stock } = await aoa.getEventAvailability({ eventId: events[0].id! });

try {
  const { data: checkout } = await aoa.createTicketCheckout(
    {
      eventId: events[0].id!,
      tickets: [{ ticketTypeId: 'tt_…', quantity: 2 }],
      buyer: { email: 'typed-by-buyer@example.com', name: 'Typed by the buyer' },
    },
    { idempotencyKey: `order-${orderId}` },
  );
  // Send the person to checkout.paymentUrl, then poll:
  const { data: order } = await aoa.getOrder({ paymentId: checkout.paymentId });
} catch (error) {
  if (error instanceof AoaApiError && error.code === 'conflict') {
    // sold out meanwhile or payments not configured: re-read availability
  }
  throw error;
}

// Every page of a list, following meta.nextCursor when the server sends it:
for await (const location of aoa.paginate('searchLocations', { city: 'Львів' })) {
  console.log(location.name, location.url);
}

console.log(aoa.rateLimit); // { limit, remaining, resetSeconds, windowSeconds }
```

The types are generated from the OpenAPI spec (`npm run generate:fetch` in
`sdk/typescript`), so a new API operation becomes a typed method without
hand-written code.

## Python (`aoa-sdk`)

```python
import time
from aoa_sdk import AoaApiError, AoaClient, TERMINAL_ORDER_STATUSES

client = AoaClient(max_retries=2)  # key from AOA_API_KEY

events = client.search_events(city="Київ", limit=10).data
stock = client.get_event_availability(events[0]["id"]).data

try:
    checkout = client.create_ticket_checkout(
        event_id=events[0]["id"],
        tickets=[{"ticketTypeId": "tt_…", "quantity": 2}],
        buyer={"email": "typed-by-buyer@example.com", "name": "Typed by the buyer"},
        idempotency_key=f"order-{order_id}",
    ).data
except AoaApiError as error:
    if error.code == "rate_limited":
        print("retry after", error.rate_limit.retry_after_seconds)
    raise

while True:
    order = client.get_order(checkout["paymentId"]).data
    if order["status"] in TERMINAL_ORDER_STATUSES:
        break
    time.sleep(5)

for location in client.paginate(client.search_locations, city="Львів"):
    print(location["name"], location["url"])
```

## Go (`github.com/aoa-ua/aoa-agent-kit/sdk/go`)

```go
import aoa "github.com/aoa-ua/aoa-agent-kit/sdk/go"

client := aoa.NewClient(aoa.WithMaxRetries(2)) // key from AOA_API_KEY

events, err := client.SearchEvents(ctx, &aoa.SearchEventsParams{City: "Київ", Limit: 10})
if err != nil {
	return err
}

checkout, err := client.CreateTicketCheckout(ctx, &aoa.CreateTicketCheckoutParams{
	EventID: events.Data[0].ID,
	Tickets: []aoa.TicketSelection{{TicketTypeID: "tt_…", Quantity: 2}},
	Buyer:   aoa.TicketBuyer{Email: "typed-by-buyer@example.com", Name: "Typed by the buyer"},
}, aoa.WithIdempotencyKey("order-"+orderID))

var apiErr *aoa.APIError
if errors.As(err, &apiErr) && apiErr.Code == "conflict" {
	// sold out meanwhile or payments not configured
}

for {
	order, err := client.GetOrder(ctx, checkout.Data.PaymentID)
	if err != nil || aoa.IsTerminalOrderStatus(order.Data.Status) {
		break
	}
	time.Sleep(5 * time.Second)
}
```

Pagination in Go: pass `resp.NextCursor()` as `Cursor` of the next
`SearchEventsParams` / `SearchLocationsParams` until it is empty.
