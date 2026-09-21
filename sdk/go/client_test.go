package aoa

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

const testKey = "aoa_live_test_key_not_real"

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type recorded struct {
	Method string
	Path   string // escaped path
	Query  map[string][]string
	Header http.Header
	Body   map[string]any
}

type reply struct {
	status  int
	body    string
	headers map[string]string
}

// fakeAPI records requests and answers from a queue (the last reply repeats).
type fakeAPI struct {
	mu       sync.Mutex
	replies  []reply
	requests []recorded
	server   *httptest.Server
}

func newFakeAPI(t *testing.T, replies ...reply) *fakeAPI {
	t.Helper()
	api := &fakeAPI{replies: replies}
	api.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		api.mu.Lock()
		api.requests = append(api.requests, recorded{
			Method: r.Method,
			Path:   r.URL.EscapedPath(),
			Query:  r.URL.Query(),
			Header: r.Header.Clone(),
			Body:   body,
		})
		next := api.replies[0]
		if len(api.replies) > 1 {
			api.replies = api.replies[1:]
		}
		api.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		for name, value := range next.headers {
			w.Header().Set(name, value)
		}
		status := next.status
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, next.body)
	}))
	t.Cleanup(api.server.Close)
	return api
}

func (api *fakeAPI) client(opts ...Option) *Client {
	return NewClient(append([]Option{WithBaseURL(api.server.URL + "/api/v1"), WithAPIKey("")}, opts...)...)
}

func (api *fakeAPI) last() recorded {
	api.mu.Lock()
	defer api.mu.Unlock()
	return api.requests[len(api.requests)-1]
}

func ok(body string) reply { return reply{body: body} }

func TestSearchEventsBuildsQueryWithoutKey(t *testing.T) {
	api := newFakeAPI(t, reply{
		body: `{"data":[{"id":"a1b2c3","title":"Jazz"}],"meta":{"count":1,"nextCursor":"c2"}}`,
		headers: map[string]string{
			"RateLimit-Policy": `"default";q=60;w=60`,
			"RateLimit":        `"default";r=59;t=60`,
		},
	})
	client := api.client()
	resp, err := client.SearchEvents(context.Background(), &SearchEventsParams{City: "Київ", Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Data) != 1 || resp.Data[0].ID != "a1b2c3" {
		t.Fatalf("unexpected data: %+v", resp.Data)
	}
	if resp.NextCursor() != "c2" {
		t.Fatalf("NextCursor = %q", resp.NextCursor())
	}
	req := api.last()
	if req.Method != http.MethodGet || req.Path != "/api/v1/events" {
		t.Fatalf("got %s %s", req.Method, req.Path)
	}
	if req.Query["city"][0] != "Київ" || req.Query["limit"][0] != "5" {
		t.Fatalf("query = %v", req.Query)
	}
	if req.Header.Get("Authorization") != "" {
		t.Fatal("reads must not need a key")
	}
	if !strings.HasPrefix(req.Header.Get("User-Agent"), "aoa-sdk-go/"+Version) {
		t.Fatalf("User-Agent = %q", req.Header.Get("User-Agent"))
	}
	rl := client.RateLimit()
	if rl == nil || *rl.Limit != 60 || *rl.Remaining != 59 || *rl.ResetSeconds != 60 || *rl.WindowSeconds != 60 {
		t.Fatalf("rate limit = %+v", rl)
	}
}

func TestReadPathsAndEncoding(t *testing.T) {
	api := newFakeAPI(t, ok(`{"data":null}`))
	client := api.client()
	ctx := context.Background()
	bookable := false
	if _, err := client.SearchLocations(ctx, &SearchLocationsParams{Bookable: &bookable}); err != nil {
		t.Fatal(err)
	}
	if api.last().Query["bookable"][0] != "false" {
		t.Fatalf("bookable query = %v", api.last().Query)
	}
	calls := []func() error{
		func() error { _, err := client.GetLocation(ctx, "loc1"); return err },
		func() error { _, err := client.GetTableAvailability(ctx, "loc1", "2026-10-01"); return err },
		func() error { _, err := client.GetEvent(ctx, "a b/c"); return err },
		func() error { _, err := client.GetEventTicketTypes(ctx, "e1"); return err },
		func() error { _, err := client.GetEventAvailability(ctx, "e1"); return err },
	}
	want := []string{
		"/api/v1/locations/loc1",
		"/api/v1/locations/loc1/availability",
		"/api/v1/events/a%20b%2Fc",
		"/api/v1/events/e1/ticket-types",
		"/api/v1/events/e1/availability",
	}
	for i, call := range calls {
		if err := call(); err != nil {
			t.Fatal(err)
		}
		if got := api.last().Path; got != want[i] {
			t.Fatalf("call %d path = %s, want %s", i, got, want[i])
		}
	}
	if _, err := client.GetEvent(ctx, ""); err == nil {
		t.Fatal("empty eventId must fail")
	}
}

func TestWritesNeedKeyBeforeRequest(t *testing.T) {
	api := newFakeAPI(t, ok(`{"data":{}}`))
	client := api.client()
	_, err := client.GetOrder(context.Background(), "p1")
	if !errors.Is(err, ErrAPIKeyRequired) {
		t.Fatalf("err = %v", err)
	}
	if len(api.requests) != 0 {
		t.Fatal("no request expected")
	}
}

func TestCheckoutSendsBodyAuthAndGeneratedKey(t *testing.T) {
	api := newFakeAPI(t, ok(`{"data":{"paymentId":"p1","paymentUrl":"https://pay.example/p1"}}`))
	client := api.client(WithAPIKey(testKey), WithAgentProvider("my-agent"))
	resp, err := client.CreateTicketCheckout(context.Background(), &CreateTicketCheckoutParams{
		EventID: "a1b2c3",
		Tickets: []TicketSelection{{TicketTypeID: "tt1", Quantity: 2}},
		Buyer:   TicketBuyer{Email: "buyer@example.com", Name: "Test Buyer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Data.PaymentURL != "https://pay.example/p1" {
		t.Fatalf("data = %+v", resp.Data)
	}
	req := api.last()
	if req.Method != http.MethodPost || req.Path != "/api/v1/checkout" {
		t.Fatalf("got %s %s", req.Method, req.Path)
	}
	if req.Header.Get("Authorization") != "Bearer "+testKey || req.Header.Get("X-Agent-Provider") != "my-agent" {
		t.Fatalf("headers = %v", req.Header)
	}
	if !uuidPattern.MatchString(req.Header.Get("Idempotency-Key")) {
		t.Fatalf("Idempotency-Key = %q", req.Header.Get("Idempotency-Key"))
	}
	if req.Body["eventId"] != "a1b2c3" || req.Body["buyer"].(map[string]any)["email"] != "buyer@example.com" {
		t.Fatalf("body = %v", req.Body)
	}
	if _, present := req.Body["couponCode"]; present {
		t.Fatal("empty optional fields must be omitted")
	}
}

func TestTableReservationNeedsConfirmationAndKeepsKey(t *testing.T) {
	api := newFakeAPI(t, ok(`{"data":{"reservationId":"r1","status":"PENDING"}}`))
	client := api.client(WithAPIKey(testKey))
	params := &CreateTableReservationParams{
		LocationID: "loc1",
		Date:       "2026-10-01",
		Time:       "19:00",
		PartySize:  2,
		Guest:      GuestContact{Name: "Typed by the guest", Phone: "+380000000000"},
	}
	if _, err := client.CreateTableReservation(context.Background(), params); !errors.Is(err, ErrNotConfirmed) {
		t.Fatalf("err = %v", err)
	}
	params.ConfirmedByUser = true
	resp, err := client.CreateTableReservation(context.Background(), params, WithIdempotencyKey("cart-42-booking"))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Data.ReservationID != "r1" {
		t.Fatalf("data = %+v", resp.Data)
	}
	req := api.last()
	if req.Path != "/api/v1/table-reservations" || req.Header.Get("Idempotency-Key") != "cart-42-booking" {
		t.Fatalf("got %s key %q", req.Path, req.Header.Get("Idempotency-Key"))
	}
	if req.Body["confirmedByUser"] != true || req.Body["partySize"].(float64) != 2 {
		t.Fatalf("body = %v", req.Body)
	}
	if len(api.requests) != 1 {
		t.Fatal("the unconfirmed call must not reach the API")
	}
}

func TestTicketReservationHasNoIdempotencyKey(t *testing.T) {
	api := newFakeAPI(t, ok(`{"data":{"reservationId":"r1"}}`))
	client := api.client(WithAPIKey(testKey))
	_, err := client.CreateTicketReservation(context.Background(), &CreateTicketReservationParams{
		EventID: "e1",
		Tickets: []TicketSelection{{TicketTypeID: "tt1", Quantity: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if req := api.last(); req.Path != "/api/v1/reservations" || req.Header.Get("Idempotency-Key") != "" {
		t.Fatalf("got %s key %q", req.Path, req.Header.Get("Idempotency-Key"))
	}
}

func TestWebhookManagementVerbs(t *testing.T) {
	api := newFakeAPI(t, ok(`{"data":null}`))
	client := api.client(WithAPIKey(testKey))
	ctx := context.Background()
	active := true
	steps := []func() error{
		func() error { _, err := client.ListWebhooks(ctx); return err },
		func() error {
			_, err := client.CreateWebhook(ctx, &CreateWebhookParams{URL: "https://example.com/hooks/aoa", Events: []WebhookEventType{EventOrderPaid}})
			return err
		},
		func() error {
			_, err := client.UpdateWebhook(ctx, "wh1", &UpdateWebhookParams{IsActive: &active})
			return err
		},
		func() error { _, err := client.DeleteWebhook(ctx, "wh1"); return err },
		func() error { _, err := client.GetOrder(ctx, "p1"); return err },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{
		"GET /api/v1/webhooks",
		"POST /api/v1/webhooks",
		"PATCH /api/v1/webhooks/wh1",
		"DELETE /api/v1/webhooks/wh1",
		"GET /api/v1/orders/p1",
	}
	for i, req := range api.requests {
		if got := req.Method + " " + req.Path; got != want[i] {
			t.Fatalf("request %d = %s, want %s", i, got, want[i])
		}
	}
	if api.requests[2].Body["isActive"] != true || len(api.requests[2].Body) != 1 {
		t.Fatalf("patch body = %v", api.requests[2].Body)
	}
	if api.requests[1].Body["events"].([]any)[0] != "order.paid" {
		t.Fatalf("create body = %v", api.requests[1].Body)
	}
}

func TestBatchOperations(t *testing.T) {
	api := newFakeAPI(t, ok(`{"data":[{"id":"a","status":200,"body":{"data":{}}}]}`))
	resp, err := api.client().BatchOperations(context.Background(), &BatchOperationsParams{
		Operations: []BatchOperation{{ID: "a", Path: "/events/e1/availability"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Data) != 1 || resp.Data[0].Status != 200 || string(resp.Data[0].Body) != `{"data":{}}` {
		t.Fatalf("data = %+v", resp.Data)
	}
	req := api.last()
	if req.Method != http.MethodPost || req.Path != "/api/v1/batch" || req.Header.Get("Authorization") != "" {
		t.Fatalf("got %s %s", req.Method, req.Path)
	}
	operations := req.Body["operations"].([]any)
	if operations[0].(map[string]any)["path"] != "/events/e1/availability" {
		t.Fatalf("body = %v", req.Body)
	}
}

func TestCheckoutRespondAsync(t *testing.T) {
	api := newFakeAPI(t, reply{
		status:  http.StatusAccepted,
		body:    `{"data":{"paymentId":"p1","paymentUrl":"https://pay.example/p1","status":"PENDING","statusUrl":"https://aoa.com.ua/api/v1/orders/p1"}}`,
		headers: map[string]string{"Retry-After": "5"},
	})
	resp, err := api.client(WithAPIKey(testKey)).CreateTicketCheckout(context.Background(), &CreateTicketCheckoutParams{
		EventID: "e1",
		Tickets: []TicketSelection{{TicketTypeID: "tt1", Quantity: 1}},
		Buyer:   TicketBuyer{Email: "buyer@example.com", Name: "Test Buyer"},
	}, WithRespondAsync())
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusAccepted || resp.Data.StatusURL != "https://aoa.com.ua/api/v1/orders/p1" || resp.Data.Status != "PENDING" {
		t.Fatalf("resp = %+v", resp)
	}
	if api.last().Header.Get("Prefer") != "respond-async" {
		t.Fatal("Prefer header missing")
	}
}

func TestErrorEnvelope(t *testing.T) {
	api := newFakeAPI(t, reply{status: 404, body: `{"error":{"code":"not_found","message":"Event not found","hint":"Check the id"}}`})
	_, err := api.client().GetEvent(context.Background(), "missing")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %T %v", err, err)
	}
	if apiErr.StatusCode != 404 || apiErr.Code != "not_found" || apiErr.Message != "Event not found" || apiErr.Hint != "Check the id" || apiErr.Retryable() {
		t.Fatalf("apiErr = %+v", apiErr)
	}
}

func TestNonJSONError(t *testing.T) {
	api := newFakeAPI(t, reply{status: 502, body: "<html>bad gateway</html>", headers: map[string]string{"Content-Type": "text/html"}})
	_, err := api.client().SearchEvents(context.Background(), nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "http_502" || apiErr.Message != "Bad Gateway" {
		t.Fatalf("err = %v", err)
	}
}

func TestRateLimitedWithoutRetry(t *testing.T) {
	api := newFakeAPI(t, reply{
		status:  429,
		body:    `{"error":{"code":"rate_limited","message":"Too many requests"}}`,
		headers: map[string]string{"Retry-After": "42", "RateLimit": `"default";r=0;t=42`},
	})
	_, err := api.client().SearchEvents(context.Background(), nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "rate_limited" || !apiErr.Retryable() || *apiErr.RateLimit.RetryAfterSeconds != 42 {
		t.Fatalf("err = %v", err)
	}
	if len(api.requests) != 1 {
		t.Fatalf("requests = %d", len(api.requests))
	}
}

func TestRetryReusesIdempotencyKey(t *testing.T) {
	api := newFakeAPI(t,
		reply{status: 429, body: `{"error":{"code":"rate_limited","message":"slow down"}}`, headers: map[string]string{"Retry-After": "3"}},
		ok(`{"data":{"paymentId":"p1","paymentUrl":"https://pay.example/p1"}}`),
	)
	client := api.client(WithAPIKey(testKey), WithMaxRetries(2))
	var waited []time.Duration
	client.sleep = func(_ context.Context, d time.Duration) error { waited = append(waited, d); return nil }
	_, err := client.CreateTicketCheckout(context.Background(), &CreateTicketCheckoutParams{
		EventID: "e1",
		Tickets: []TicketSelection{{TicketTypeID: "tt1", Quantity: 1}},
		Buyer:   TicketBuyer{Email: "buyer@example.com", Name: "Test Buyer"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(waited) != 1 || waited[0] != 3*time.Second {
		t.Fatalf("waited = %v", waited)
	}
	first, second := api.requests[0].Header.Get("Idempotency-Key"), api.requests[1].Header.Get("Idempotency-Key")
	if first == "" || first != second {
		t.Fatalf("keys %q and %q differ", first, second)
	}
}

func TestLongRetryAfterIsReturned(t *testing.T) {
	api := newFakeAPI(t, reply{status: 429, body: `{"error":{"code":"rate_limited","message":"x"}}`, headers: map[string]string{"Retry-After": "600"}})
	client := api.client(WithMaxRetries(3), WithMaxRetryDelay(10*time.Second))
	client.sleep = func(context.Context, time.Duration) error { t.Fatal("must not wait"); return nil }
	if _, err := client.SearchEvents(context.Background(), nil); err == nil {
		t.Fatal("expected an error")
	}
}

func TestRedirectsAreNotFollowed(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("redirect was followed with Authorization %q", r.Header.Get("Authorization"))
	}))
	defer target.Close()
	api := newFakeAPI(t, reply{status: 302, headers: map[string]string{"Location": target.URL}})
	_, err := api.client(WithAPIKey(testKey)).GetEvent(context.Background(), "e1")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 302 {
		t.Fatalf("err = %v", err)
	}
}

func TestParseRateLimitFallbacksAndDate(t *testing.T) {
	if parseRateLimit(http.Header{}, time.Now()) != nil {
		t.Fatal("expected nil without headers")
	}
	h := http.Header{}
	h.Set("X-RateLimit-Limit", "600")
	h.Set("X-RateLimit-Remaining", "10")
	h.Set("Retry-After", "Mon, 21 Sep 2026 12:00:30 GMT")
	now := time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)
	rl := parseRateLimit(h, now)
	if *rl.Limit != 600 || *rl.Remaining != 10 || *rl.RetryAfterSeconds != 30 {
		t.Fatalf("rl = %+v", rl)
	}
}

func TestNewUUID(t *testing.T) {
	if !uuidPattern.MatchString(newUUID()) {
		t.Fatal("not a v4 UUID")
	}
}
