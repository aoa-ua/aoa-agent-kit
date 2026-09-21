package aoa

import "encoding/json"

// Models mirror components.schemas of https://aoa.com.ua/openapi.json.
// Nullable fields are pointers. Timestamps are kept as the ISO 8601 strings
// the API sends (dates as YYYY-MM-DD), so a format change never breaks
// decoding of the whole response.

// WebhookEventType is a webhook subscription type.
type WebhookEventType string

// Webhook event types accepted by CreateWebhook.
const (
	EventOrderPaid          WebhookEventType = "order.paid"
	EventOrderFailed        WebhookEventType = "order.failed"
	EventOrderRefunded      WebhookEventType = "order.refunded"
	EventEventCancelled     WebhookEventType = "event.cancelled"
	EventEventUpdated       WebhookEventType = "event.updated"
	EventAttendeeRegistered WebhookEventType = "attendee.registered"
	EventAttendeeCheckedIn  WebhookEventType = "attendee.checked_in"
)

// Order statuses. Polling can stop on SUCCESS, FAILED, EXPIRED or REFUNDED.
const (
	OrderPending    = "PENDING"
	OrderProcessing = "PROCESSING"
	OrderSuccess    = "SUCCESS"
	OrderFailed     = "FAILED"
	OrderExpired    = "EXPIRED"
	OrderRefunded   = "REFUNDED"
)

// IsTerminalOrderStatus reports whether polling GetOrder can stop.
func IsTerminalOrderStatus(status string) bool {
	switch status {
	case OrderSuccess, OrderFailed, OrderExpired, OrderRefunded:
		return true
	}
	return false
}

// Location is a venue.
type Location struct {
	ID                  string   `json:"id"`
	Name                string   `json:"name"`
	Address             *string  `json:"address"`
	City                *string  `json:"city"`
	Phone               *string  `json:"phone"`
	URL                 string   `json:"url"`
	ImageURL            *string  `json:"imageUrl"`
	OpeningHours        *string  `json:"openingHours"`
	Latitude            *float64 `json:"latitude"`
	Longitude           *float64 `json:"longitude"`
	ReservationsEnabled bool     `json:"reservationsEnabled"`
	MaxGuests           int      `json:"maxGuests"`
}

// TableSlot is one bookable time.
type TableSlot struct {
	Value     string `json:"value"`
	Label     string `json:"label"`
	Available bool   `json:"available"`
}

// TableAvailability lists the slots of one date. Reason is ok, disabled,
// closed or no_slots.
type TableAvailability struct {
	LocationID string      `json:"locationId"`
	Date       string      `json:"date"`
	Reason     string      `json:"reason"`
	MaxGuests  int         `json:"maxGuests"`
	Slots      []TableSlot `json:"slots"`
}

// EventSummary is an item of SearchEvents. ID is the event shortId.
type EventSummary struct {
	ID        string  `json:"id"`
	URL       string  `json:"url"`
	Title     string  `json:"title"`
	StartAt   *string `json:"startAt"`
	EndAt     *string `json:"endAt"`
	ImageURL  *string `json:"imageUrl"`
	EventType *string `json:"eventType"`
	Status    *string `json:"status"`
	City      *string `json:"city"`
	Venue     *string `json:"venue"`
}

// TicketType is a ticket tier with its price and stock. Prices are in kopecks
// (PriceMinor) and as a decimal string (PriceDecimal). Status is on_sale,
// sold_out, sales_not_started or sales_ended.
type TicketType struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	PriceMinor   int64   `json:"priceMinor"`
	PriceDecimal string  `json:"priceDecimal"`
	Currency     string  `json:"currency"`
	IsFree       bool    `json:"isFree"`
	Capacity     *int    `json:"capacity"`
	Sold         int     `json:"sold"`
	Remaining    *int    `json:"remaining"`
	SalesStart   *string `json:"salesStart"`
	SalesEnd     *string `json:"salesEnd"`
	Status       string  `json:"status"`
}

// RefundPolicy of an event.
type RefundPolicy struct {
	RefundsEnabled      bool `json:"refundsEnabled"`
	RefundDeadlineHours *int `json:"refundDeadlineHours"`
}

// EventDetail is returned by GetEvent.
type EventDetail struct {
	ID             string         `json:"id"`
	URL            string         `json:"url"`
	Title          string         `json:"title"`
	Description    *string        `json:"description"`
	ImageURL       *string        `json:"imageUrl"`
	StartAt        *string        `json:"startAt"`
	EndAt          *string        `json:"endAt"`
	AllDay         bool           `json:"allDay"`
	EventType      *string        `json:"eventType"`
	Status         *string        `json:"status"`
	AttendanceMode string         `json:"attendanceMode"`
	Capacity       *int           `json:"capacity"`
	Location       map[string]any `json:"location"`
	Organizer      map[string]any `json:"organizer"`
	RefundPolicy   RefundPolicy   `json:"refundPolicy"`
	TicketTypes    []TicketType   `json:"ticketTypes"`
}

// EventAvailability maps ticketTypeId to remaining tickets; the map is empty
// when capacity is unlimited.
type EventAvailability struct {
	EventID     string         `json:"eventId"`
	TicketTypes map[string]int `json:"ticketTypes"`
	CheckedAt   string         `json:"checkedAt"`
}

// TicketSelection is one line of a reservation or checkout. Quantity is 1..20.
type TicketSelection struct {
	TicketTypeID string `json:"ticketTypeId"`
	Quantity     int    `json:"quantity"`
}

// GuestContact is typed by the guest in person, never invented by an agent.
type GuestContact struct {
	Name  string `json:"name"`
	Phone string `json:"phone"`
	Email string `json:"email,omitempty"`
}

// TicketBuyer receives the ticket by email after payment.
type TicketBuyer struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Phone string `json:"phone,omitempty"`
}

// TableReservation is a booking request; the venue still has to confirm it.
type TableReservation struct {
	ReservationID string  `json:"reservationId"`
	Status        string  `json:"status"`
	LocationID    string  `json:"locationId"`
	LocationName  *string `json:"locationName"`
	Date          string  `json:"date"`
	Time          string  `json:"time"`
	PartySize     int     `json:"partySize"`
}

// TicketReservation holds tickets for 15 minutes.
type TicketReservation struct {
	ReservationID string         `json:"reservationId"`
	EventID       string         `json:"eventId"`
	ExpiresAt     string         `json:"expiresAt"`
	Remaining     map[string]int `json:"remaining"`
}

// Checkout is a created payment: send the person to PaymentURL, then poll
// GetOrder(PaymentID). Status and StatusURL are set only with
// WithRespondAsync (HTTP 202).
type Checkout struct {
	PaymentID  string `json:"paymentId"`
	PaymentURL string `json:"paymentUrl"`
	Status     string `json:"status,omitempty"`
	StatusURL  string `json:"statusUrl,omitempty"`
}

// BatchOperation is one read inside BatchOperations. Path is relative to
// /api/v1 and may carry a query, e.g. "/events/AB12CD34/availability".
type BatchOperation struct {
	// ID is echoed in the result (up to 64 chars); defaults to the index.
	ID string `json:"id,omitempty"`
	// Method may only be GET; empty means GET.
	Method string `json:"method,omitempty"`
	Path   string `json:"path"`
}

// BatchResult is the outcome of one BatchOperation. Body is the operation
// response: {"data": ...} or {"error": ...}.
type BatchResult struct {
	ID     string          `json:"id"`
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

// Order is the status of a payment.
type Order struct {
	PaymentID     string  `json:"paymentId"`
	EventID       string  `json:"eventId"`
	Status        string  `json:"status"`
	AmountMinor   int64   `json:"amountMinor"`
	AmountDecimal string  `json:"amountDecimal"`
	Currency      string  `json:"currency"`
	AttendeeID    *string `json:"attendeeId"`
	FailureReason *string `json:"failureReason"`
	CreatedAt     string  `json:"createdAt"`
	PaidAt        *string `json:"paidAt"`
}

// WebhookEndpoint is a registered webhook URL.
type WebhookEndpoint struct {
	ID            string   `json:"id"`
	URL           string   `json:"url"`
	SecretPrefix  string   `json:"secretPrefix"`
	Events        []string `json:"events"`
	IsActive      bool     `json:"isActive"`
	FailureCount  int      `json:"failureCount"`
	DisabledAt    *string  `json:"disabledAt"`
	LastSuccessAt *string  `json:"lastSuccessAt"`
	CreatedAt     string   `json:"createdAt"`
}

// WebhookEndpointCreated carries the signing secret, shown only once.
type WebhookEndpointCreated struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Events    []string `json:"events"`
	Secret    string   `json:"secret"`
	CreatedAt string   `json:"createdAt"`
}

// WebhookEndpointUpdated is returned by UpdateWebhook.
type WebhookEndpointUpdated struct {
	ID           string   `json:"id"`
	URL          string   `json:"url"`
	Events       []string `json:"events"`
	IsActive     bool     `json:"isActive"`
	FailureCount int      `json:"failureCount"`
	DisabledAt   *string  `json:"disabledAt"`
}

// DeleteResult is returned by DeleteWebhook.
type DeleteResult struct {
	Deleted bool `json:"deleted"`
}
