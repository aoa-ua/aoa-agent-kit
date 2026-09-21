package aoa

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Version of this SDK.
const Version = "0.1.0"

// DefaultBaseURL is the production API root.
const DefaultBaseURL = "https://aoa.com.ua/api/v1"

const (
	defaultTimeout       = 30 * time.Second
	defaultMaxRetryDelay = 60 * time.Second
)

// ErrAPIKeyRequired is returned, before any request, by operations that need
// a partner API key when the client has none.
var ErrAPIKeyRequired = errors.New("aoa: this operation needs a partner API key: use WithAPIKey or set AOA_API_KEY")

// Client calls the AOA API. It is safe for concurrent use.
type Client struct {
	baseURL       string
	apiKey        string
	httpClient    *http.Client
	maxRetries    int
	maxRetryDelay time.Duration
	agentProvider string
	userAgent     string
	headers       http.Header
	sleep         func(context.Context, time.Duration) error
	newKey        func() string

	mu        sync.Mutex
	rateLimit *RateLimit
}

// Option configures a Client.
type Option func(*Client)

// WithAPIKey sets the partner API key (aoa_live_...). Needed for writes; on
// reads it raises the limit from 60 to 600 requests per minute.
func WithAPIKey(key string) Option { return func(c *Client) { c.apiKey = key } }

// WithBaseURL overrides DefaultBaseURL.
func WithBaseURL(baseURL string) Option { return func(c *Client) { c.baseURL = baseURL } }

// WithHTTPClient replaces the HTTP client. The default one has a 30 s
// timeout and does not follow redirects (so the API key never leaves the
// configured origin); keep both properties in yours.
func WithHTTPClient(httpClient *http.Client) Option {
	return func(c *Client) { c.httpClient = httpClient }
}

// WithMaxRetries retries responses with status 429 up to n times, waiting for
// Retry-After. Default 0: never retry.
func WithMaxRetries(n int) Option { return func(c *Client) { c.maxRetries = n } }

// WithMaxRetryDelay caps one wait between retries; a longer Retry-After is
// returned as an *APIError instead. Default 60 s.
func WithMaxRetryDelay(d time.Duration) Option { return func(c *Client) { c.maxRetryDelay = d } }

// WithAgentProvider sets X-Agent-Provider, an analytics identifier of your
// connector. It is never used for authorization.
func WithAgentProvider(name string) Option { return func(c *Client) { c.agentProvider = name } }

// WithUserAgent appends a token to the SDK user agent.
func WithUserAgent(token string) Option {
	return func(c *Client) { c.userAgent = strings.TrimSpace(c.userAgent + " " + token) }
}

// WithHeader adds a header to every request.
func WithHeader(name, value string) Option {
	return func(c *Client) { c.headers.Set(name, value) }
}

// NewClient creates a client. Without WithAPIKey it reads AOA_API_KEY.
func NewClient(opts ...Option) *Client {
	c := &Client{
		baseURL: DefaultBaseURL,
		apiKey:  os.Getenv("AOA_API_KEY"),
		httpClient: &http.Client{
			Timeout: defaultTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		maxRetryDelay: defaultMaxRetryDelay,
		userAgent:     "aoa-sdk-go/" + Version,
		headers:       http.Header{},
		sleep:         sleepContext,
		newKey:        newUUID,
	}
	for _, opt := range opts {
		opt(c)
	}
	c.baseURL = strings.TrimRight(c.baseURL, "/")
	return c
}

// RateLimit returns the rate-limit state of the most recent response, or nil.
func (c *Client) RateLimit() *RateLimit {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.rateLimit == nil {
		return nil
	}
	copied := *c.rateLimit
	return &copied
}

// Response is a successful API response.
type Response[T any] struct {
	// Data is the `data` field of the envelope.
	Data T
	// Meta is the optional `meta` field (pagination, idempotent replay).
	Meta       map[string]any
	StatusCode int
	Header     http.Header
	RateLimit  *RateLimit
}

// NextCursor returns meta.nextCursor, or "" when there is no next page.
func (r *Response[T]) NextCursor() string {
	if r == nil || r.Meta == nil {
		return ""
	}
	cursor, _ := r.Meta["nextCursor"].(string)
	return cursor
}

// RequestOption configures a single call.
type RequestOption func(*requestConfig)

type requestConfig struct {
	idempotencyKey string
	headers        http.Header
}

// WithIdempotencyKey sets Idempotency-Key. Tie it to your order or cart id so
// a retry after a crash cannot create a second booking or payment.
func WithIdempotencyKey(key string) RequestOption {
	return func(rc *requestConfig) { rc.idempotencyKey = key }
}

// WithRequestHeader adds a header to this call only.
func WithRequestHeader(name, value string) RequestOption {
	return func(rc *requestConfig) { rc.headers.Set(name, value) }
}

// operation describes one endpoint of the spec.
type operation struct {
	method       string
	path         string // spec form, e.g. "/events/{eventId}"
	requiresAuth bool
	// generateKey sends a generated Idempotency-Key when the caller gave none.
	generateKey bool
}

func do[T any](
	ctx context.Context,
	c *Client,
	op operation,
	pathParams map[string]string,
	query url.Values,
	body any,
	opts []RequestOption,
) (*Response[T], error) {
	if op.requiresAuth && c.apiKey == "" {
		return nil, ErrAPIKeyRequired
	}
	cfg := requestConfig{headers: http.Header{}}
	for _, opt := range opts {
		opt(&cfg)
	}

	path := op.path
	for name, value := range pathParams {
		if value == "" {
			return nil, fmt.Errorf("aoa: %s is required", name)
		}
		path = strings.ReplaceAll(path, "{"+name+"}", url.PathEscape(value))
	}
	endpoint := c.baseURL + path
	if encoded := query.Encode(); encoded != "" {
		endpoint += "?" + encoded
	}

	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return nil, fmt.Errorf("aoa: encode request body: %w", err)
		}
	}

	key := cfg.idempotencyKey
	if key == "" && op.generateKey {
		key = c.newKey()
	}

	for attempt := 0; ; attempt++ {
		var reader io.Reader
		if payload != nil {
			reader = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, op.method, endpoint, reader)
		if err != nil {
			return nil, fmt.Errorf("aoa: build request: %w", err)
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", c.userAgent)
		if c.apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+c.apiKey)
		}
		if c.agentProvider != "" {
			req.Header.Set("X-Agent-Provider", c.agentProvider)
		}
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for name, values := range c.headers {
			req.Header[name] = values
		}
		for name, values := range cfg.headers {
			req.Header[name] = values
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("aoa: %s %s: %w", op.method, op.path, err)
		}
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("aoa: read response: %w", err)
		}

		rateLimit := parseRateLimit(resp.Header, time.Now())
		if rateLimit != nil {
			c.mu.Lock()
			c.rateLimit = rateLimit
			c.mu.Unlock()
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			var envelope struct {
				Data T              `json:"data"`
				Meta map[string]any `json:"meta"`
			}
			if err := json.Unmarshal(raw, &envelope); err != nil {
				return nil, &APIError{
					StatusCode: resp.StatusCode,
					Code:       "invalid_response",
					Message:    "expected a JSON response from the AOA API: " + err.Error(),
					RateLimit:  rateLimit,
					Body:       raw,
				}
			}
			return &Response[T]{
				Data:       envelope.Data,
				Meta:       envelope.Meta,
				StatusCode: resp.StatusCode,
				Header:     resp.Header,
				RateLimit:  rateLimit,
			}, nil
		}

		if resp.StatusCode == http.StatusTooManyRequests && attempt < c.maxRetries {
			if delay := retryDelay(rateLimit); delay <= c.maxRetryDelay {
				if err := c.sleep(ctx, delay); err != nil {
					return nil, err
				}
				continue
			}
		}
		return nil, errorFromResponse(resp.StatusCode, resp.Status, raw, rateLimit)
	}
}

func retryDelay(rateLimit *RateLimit) time.Duration {
	switch {
	case rateLimit != nil && rateLimit.RetryAfterSeconds != nil:
		return time.Duration(*rateLimit.RetryAfterSeconds) * time.Second
	case rateLimit != nil && rateLimit.ResetSeconds != nil:
		return time.Duration(*rateLimit.ResetSeconds) * time.Second
	default:
		return time.Second
	}
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// newUUID returns a random (version 4) UUID.
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("aoa: crypto/rand failed: " + err.Error())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func setString(values url.Values, name, value string) {
	if value != "" {
		values.Set(name, value)
	}
}

func setInt(values url.Values, name string, value int) {
	if value > 0 {
		values.Set(name, strconv.Itoa(value))
	}
}
