package aoa

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
)

// One method per operationId of https://aoa.com.ua/openapi.json. To add an
// operation: declare its `operation` next to the others and write a method
// that calls do[T]. A test in the monorepo fails while a spec operation has
// no method here.

var (
	opSearchLocations         = operation{method: http.MethodGet, path: "/locations"}
	opGetLocation             = operation{method: http.MethodGet, path: "/locations/{locationId}"}
	opGetTableAvailability    = operation{method: http.MethodGet, path: "/locations/{locationId}/availability"}
	opSearchEvents            = operation{method: http.MethodGet, path: "/events"}
	opGetEvent                = operation{method: http.MethodGet, path: "/events/{eventId}"}
	opGetEventTicketTypes     = operation{method: http.MethodGet, path: "/events/{eventId}/ticket-types"}
	opGetEventAvailability    = operation{method: http.MethodGet, path: "/events/{eventId}/availability"}
	opCreateTableReservation  = operation{method: http.MethodPost, path: "/table-reservations", requiresAuth: true, generateKey: true}
	opCreateTicketReservation = operation{method: http.MethodPost, path: "/reservations", requiresAuth: true}
	opCreateTicketCheckout    = operation{method: http.MethodPost, path: "/checkout", requiresAuth: true, generateKey: true}
	opBatchOperations         = operation{method: http.MethodPost, path: "/batch"}
	opListWebhooks            = operation{method: http.MethodGet, path: "/webhooks", requiresAuth: true}
	opCreateWebhook           = operation{method: http.MethodPost, path: "/webhooks", requiresAuth: true}
	opUpdateWebhook           = operation{method: http.MethodPatch, path: "/webhooks/{endpointId}", requiresAuth: true}
	opDeleteWebhook           = operation{method: http.MethodDelete, path: "/webhooks/{endpointId}", requiresAuth: true}
	opGetOrder                = operation{method: http.MethodGet, path: "/orders/{paymentId}", requiresAuth: true}
)

// ErrNotConfirmed is returned by CreateTableReservation when ConfirmedByUser
// is false: the API accepts a booking only after explicit human confirmation.
var ErrNotConfirmed = errors.New("aoa: ConfirmedByUser must be true: show the booking details to the person and get an explicit yes first")

// ── Locations (no key needed) ───────────────────────────────────────────────

// SearchLocationsParams filters SearchLocations. Zero values are omitted.
type SearchLocationsParams struct {
	Query string
	City  string
	// Bookable defaults to true on the server; pass a pointer to false to
	// include venues without online booking.
	Bookable *bool
	// Limit is 1..20 (server default 10).
	Limit int
	// Cursor is meta.nextCursor of the previous page.
	Cursor string
}

// SearchLocations finds venues (searchLocations, GET /locations).
func (c *Client) SearchLocations(ctx context.Context, params *SearchLocationsParams, opts ...RequestOption) (*Response[[]Location], error) {
	query := url.Values{}
	if params != nil {
		setString(query, "query", params.Query)
		setString(query, "city", params.City)
		if params.Bookable != nil {
			query.Set("bookable", strconv.FormatBool(*params.Bookable))
		}
		setInt(query, "limit", params.Limit)
		setString(query, "cursor", params.Cursor)
	}
	return do[[]Location](ctx, c, opSearchLocations, nil, query, nil, opts)
}

// GetLocation returns one venue (getLocation, GET /locations/{locationId}).
func (c *Client) GetLocation(ctx context.Context, locationID string, opts ...RequestOption) (*Response[Location], error) {
	return do[Location](ctx, c, opGetLocation, map[string]string{"locationId": locationID}, nil, nil, opts)
}

// GetTableAvailability returns bookable slots for a date in YYYY-MM-DD
// (getTableAvailability, GET /locations/{locationId}/availability).
func (c *Client) GetTableAvailability(ctx context.Context, locationID, date string, opts ...RequestOption) (*Response[TableAvailability], error) {
	if date == "" {
		return nil, errors.New("aoa: date is required")
	}
	return do[TableAvailability](ctx, c, opGetTableAvailability, map[string]string{"locationId": locationID}, url.Values{"date": {date}}, nil, opts)
}

// ── Events (no key needed) ──────────────────────────────────────────────────

// SearchEventsParams filters SearchEvents. Zero values are omitted.
type SearchEventsParams struct {
	// Category is a slug: workshop, lecture, party, ...
	Category string
	// City is matched case-insensitively.
	City string
	// Limit is 1..100 (server default 50).
	Limit int
	// Cursor is meta.nextCursor of the previous page.
	Cursor string
}

// SearchEvents lists published upcoming events (searchEvents, GET /events).
func (c *Client) SearchEvents(ctx context.Context, params *SearchEventsParams, opts ...RequestOption) (*Response[[]EventSummary], error) {
	query := url.Values{}
	if params != nil {
		setString(query, "category", params.Category)
		setString(query, "city", params.City)
		setInt(query, "limit", params.Limit)
		setString(query, "cursor", params.Cursor)
	}
	return do[[]EventSummary](ctx, c, opSearchEvents, nil, query, nil, opts)
}

// GetEvent returns event details by shortId or full id
// (getEvent, GET /events/{eventId}).
func (c *Client) GetEvent(ctx context.Context, eventID string, opts ...RequestOption) (*Response[EventDetail], error) {
	return do[EventDetail](ctx, c, opGetEvent, map[string]string{"eventId": eventID}, nil, nil, opts)
}

// GetEventTicketTypes lists ticket types with price and stock
// (getEventTicketTypes, GET /events/{eventId}/ticket-types).
func (c *Client) GetEventTicketTypes(ctx context.Context, eventID string, opts ...RequestOption) (*Response[[]TicketType], error) {
	return do[[]TicketType](ctx, c, opGetEventTicketTypes, map[string]string{"eventId": eventID}, nil, nil, opts)
}

// GetEventAvailability returns live remaining tickets per type
// (getEventAvailability, GET /events/{eventId}/availability).
func (c *Client) GetEventAvailability(ctx context.Context, eventID string, opts ...RequestOption) (*Response[EventAvailability], error) {
	return do[EventAvailability](ctx, c, opGetEventAvailability, map[string]string{"eventId": eventID}, nil, nil, opts)
}

// ── Commerce (partner API key) ──────────────────────────────────────────────

// CreateTableReservationParams is the body of CreateTableReservation.
type CreateTableReservationParams struct {
	LocationID string `json:"locationId"`
	// Date is YYYY-MM-DD, Time is HH:mm.
	Date string `json:"date"`
	Time string `json:"time"`
	// PartySize is 1..50.
	PartySize int `json:"partySize"`
	// Guest is typed by the person, never invented.
	Guest   GuestContact `json:"guest"`
	Comment string       `json:"comment,omitempty"`
	// ConfirmedByUser must be true: set it only after the person saw the
	// venue, date, time, party size and contacts and explicitly agreed.
	ConfirmedByUser bool `json:"confirmedByUser"`
}

// CreateTableReservation books a table (createTableReservation,
// POST /table-reservations, scope reservations:write). The venue still has
// to confirm the booking. An Idempotency-Key is generated unless given.
func (c *Client) CreateTableReservation(ctx context.Context, params *CreateTableReservationParams, opts ...RequestOption) (*Response[TableReservation], error) {
	if params == nil || !params.ConfirmedByUser {
		return nil, ErrNotConfirmed
	}
	return do[TableReservation](ctx, c, opCreateTableReservation, nil, nil, params, opts)
}

// CreateTicketReservationParams is the body of CreateTicketReservation.
type CreateTicketReservationParams struct {
	EventID string            `json:"eventId"`
	Tickets []TicketSelection `json:"tickets"`
}

// CreateTicketReservation holds tickets for 15 minutes, all or nothing
// (createTicketReservation, POST /reservations, scope reservations:write).
// There is no cancel call: an unused hold expires on its own.
func (c *Client) CreateTicketReservation(ctx context.Context, params *CreateTicketReservationParams, opts ...RequestOption) (*Response[TicketReservation], error) {
	return do[TicketReservation](ctx, c, opCreateTicketReservation, nil, nil, params, opts)
}

// CreateTicketCheckoutParams is the body of CreateTicketCheckout.
type CreateTicketCheckoutParams struct {
	EventID string            `json:"eventId"`
	Tickets []TicketSelection `json:"tickets"`
	Buyer   TicketBuyer       `json:"buyer"`
	// CouponCode: an unknown or expired code is an error, not full price.
	CouponCode string `json:"couponCode,omitempty"`
	// ReferralCode is required when CouponCode is "REFERRAL".
	ReferralCode string `json:"referralCode,omitempty"`
	// ReservationID converts a hold from CreateTicketReservation.
	ReservationID string `json:"reservationId,omitempty"`
}

// CreateTicketCheckout creates a payment and returns the payment page
// (createTicketCheckout, POST /checkout, scope checkout:write). Pass
// WithIdempotencyKey tied to your order; one is generated otherwise. With
// WithRespondAsync the API answers 202 and fills Status and StatusURL.
func (c *Client) CreateTicketCheckout(ctx context.Context, params *CreateTicketCheckoutParams, opts ...RequestOption) (*Response[Checkout], error) {
	return do[Checkout](ctx, c, opCreateTicketCheckout, nil, nil, params, opts)
}

// GetOrder returns the payment status (getOrder, GET /orders/{paymentId},
// scope checkout:write). Poll every 5 to 10 seconds until
// IsTerminalOrderStatus.
func (c *Client) GetOrder(ctx context.Context, paymentID string, opts ...RequestOption) (*Response[Order], error) {
	return do[Order](ctx, c, opGetOrder, map[string]string{"paymentId": paymentID}, nil, nil, opts)
}

// WithRespondAsync sends Prefer: respond-async (RFC 7240) with
// CreateTicketCheckout: the API answers 202 Accepted with a Location header
// pointing at the order status and Retry-After as the polling interval.
func WithRespondAsync() RequestOption {
	return WithRequestHeader("Prefer", "respond-async")
}

// ── Batch (no key needed) ───────────────────────────────────────────────────

// BatchOperationsParams is the body of BatchOperations: 1..20 operations.
type BatchOperationsParams struct {
	Operations []BatchOperation `json:"operations"`
}

// BatchOperations runs up to 20 read (GET) operations in one request
// (batchOperations, POST /batch). Results keep the order of Operations; each
// operation counts against the rate limit like a separate request.
func (c *Client) BatchOperations(ctx context.Context, params *BatchOperationsParams, opts ...RequestOption) (*Response[[]BatchResult], error) {
	return do[[]BatchResult](ctx, c, opBatchOperations, nil, nil, params, opts)
}

// ── Webhooks (partner API key, scope webhooks:write) ────────────────────────

// ListWebhooks lists registered endpoints (listWebhooks, GET /webhooks).
func (c *Client) ListWebhooks(ctx context.Context, opts ...RequestOption) (*Response[[]WebhookEndpoint], error) {
	return do[[]WebhookEndpoint](ctx, c, opListWebhooks, nil, nil, nil, opts)
}

// CreateWebhookParams is the body of CreateWebhook. URL must be https on
// port 443 or 8443 and resolve to a public address.
type CreateWebhookParams struct {
	URL    string             `json:"url"`
	Events []WebhookEventType `json:"events"`
}

// CreateWebhook registers an endpoint (createWebhook, POST /webhooks).
// Data.Secret is shown only once: store it to verify AOA-Signature.
func (c *Client) CreateWebhook(ctx context.Context, params *CreateWebhookParams, opts ...RequestOption) (*Response[WebhookEndpointCreated], error) {
	return do[WebhookEndpointCreated](ctx, c, opCreateWebhook, nil, nil, params, opts)
}

// UpdateWebhookParams changes an endpoint; nil or empty fields are left as is.
type UpdateWebhookParams struct {
	// IsActive true re-enables an endpoint switched off after failures and
	// resets its failure counter.
	IsActive *bool              `json:"isActive,omitempty"`
	Events   []WebhookEventType `json:"events,omitempty"`
}

// UpdateWebhook changes subscriptions or re-enables an endpoint
// (updateWebhook, PATCH /webhooks/{endpointId}).
func (c *Client) UpdateWebhook(ctx context.Context, endpointID string, params *UpdateWebhookParams, opts ...RequestOption) (*Response[WebhookEndpointUpdated], error) {
	if params == nil {
		params = &UpdateWebhookParams{}
	}
	return do[WebhookEndpointUpdated](ctx, c, opUpdateWebhook, map[string]string{"endpointId": endpointID}, nil, params, opts)
}

// DeleteWebhook removes an endpoint (deleteWebhook, DELETE /webhooks/{endpointId}).
func (c *Client) DeleteWebhook(ctx context.Context, endpointID string, opts ...RequestOption) (*Response[DeleteResult], error) {
	return do[DeleteResult](ctx, c, opDeleteWebhook, map[string]string{"endpointId": endpointID}, nil, nil, opts)
}
