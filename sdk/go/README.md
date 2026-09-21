# AOA SDK for Go

Official client for the [AOA](https://aoa.com.ua) public API: venues and
table bookings, events and tickets, checkout, orders and webhooks in Ukraine.

- One method per `operationId` of the [OpenAPI spec](https://aoa.com.ua/openapi.json),
  in PascalCase: `searchEvents` is `SearchEvents`.
- Standard library only, Go 1.22+.
- Automatic `Idempotency-Key` for table bookings and checkout, opt-in `429`
  retries honouring `Retry-After`, rate-limit state, webhook verification.
  The default HTTP client does not follow redirects, so the API key never
  leaves the configured host.

```bash
go get github.com/aoa-ua/aoa-agent-kit/sdk/go
```

## Quick start

```go
package main

import (
	"context"
	"fmt"

	aoa "github.com/aoa-ua/aoa-agent-kit/sdk/go"
)

func main() {
	ctx := context.Background()
	// Reads need no key; writes need aoa_live_... (WithAPIKey or AOA_API_KEY).
	client := aoa.NewClient(aoa.WithMaxRetries(2))

	venues, err := client.SearchLocations(ctx, &aoa.SearchLocationsParams{City: "Київ", Limit: 5})
	if err != nil {
		panic(err)
	}
	day, err := client.GetTableAvailability(ctx, venues.Data[0].ID, "2026-10-03")
	if err != nil {
		panic(err)
	}
	for _, slot := range day.Data.Slots {
		if slot.Available {
			fmt.Println(slot.Value)
		}
	}
}
```

### Book a table (after the person confirmed)

```go
booking, err := client.CreateTableReservation(ctx, &aoa.CreateTableReservationParams{
	LocationID:      venueID,
	Date:            "2026-10-03",
	Time:            "19:00",
	PartySize:       2,
	Guest:           aoa.GuestContact{Name: guestTypedName, Phone: guestTypedPhone},
	ConfirmedByUser: true, // only after an explicit yes; false returns ErrNotConfirmed
}, aoa.WithIdempotencyKey("booking-"+cartID))
```

### Errors

```go
_, err := client.GetEvent(ctx, "missing")
var apiErr *aoa.APIError
if errors.As(err, &apiErr) {
	fmt.Println(apiErr.StatusCode, apiErr.Code, apiErr.Hint, apiErr.Retryable())
}
if errors.Is(err, aoa.ErrAPIKeyRequired) {
	// a write operation without a key: nothing was sent
}
```

### Pagination

```go
params := &aoa.SearchEventsParams{City: "Львів"}
for {
	page, err := client.SearchEvents(ctx, params)
	if err != nil {
		return err
	}
	for _, event := range page.Data {
		fmt.Println(event.Title, event.URL)
	}
	if params.Cursor = page.NextCursor(); params.Cursor == "" {
		break
	}
}
```

### Several reads in one request

```go
results, err := client.BatchOperations(ctx, &aoa.BatchOperationsParams{
	Operations: []aoa.BatchOperation{
		{ID: "first", Path: "/events/AB12CD34/availability"},
		{ID: "second", Path: "/events/EF56GH78/availability"},
	},
})
// results.Data[i].Body is the raw JSON of that operation
```

`CreateTicketCheckout(ctx, params, aoa.WithRespondAsync())` sends
`Prefer: respond-async` and gets `202` with `Data.StatusURL`.

### Webhooks

```go
http.HandleFunc("/hooks/aoa", func(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body) // raw bytes, before any JSON decoding
	event, err := aoa.ConstructWebhookEvent(body, r.Header.Get(aoa.SignatureHeader), os.Getenv("AOA_WEBHOOK_SECRET"))
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.WriteHeader(http.StatusOK)
	go handle(event) // deduplicate by event.ID (= AOA-Delivery-Id)
})
```

## Development

```bash
go vet ./... && go test ./...
```

Releases of this nested module are tagged `sdk/go/vX.Y.Z`.

## Links

- Docs: https://aoa.com.ua/docs
- Repository: https://github.com/aoa-ua/aoa-agent-kit
- License: MIT
