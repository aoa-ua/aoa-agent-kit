package aoa

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Webhook headers.
const (
	// SignatureHeader carries t=<unix seconds>,v1=<hex HMAC-SHA256>.
	SignatureHeader = "AOA-Signature"
	// DeliveryIDHeader is the same on every retry of one delivery.
	DeliveryIDHeader = "AOA-Delivery-Id"
	EventTypeHeader  = "AOA-Event-Type"
)

// DefaultWebhookTolerance is the replay window recommended by the AOA docs.
const DefaultWebhookTolerance = 5 * time.Minute

// ErrInvalidSignature means AOA-Signature is missing, malformed, stale or
// does not match the body.
var ErrInvalidSignature = errors.New("aoa: invalid AOA-Signature")

// WebhookEvent is a delivery body. ID equals AOA-Delivery-Id. The shape of
// Data depends on Type: see https://aoa.com.ua/docs/webhooks/events.
type WebhookEvent struct {
	ID        string           `json:"id"`
	Type      WebhookEventType `json:"type"`
	CreatedAt string           `json:"createdAt"`
	Data      json.RawMessage  `json:"data"`
}

// VerifyWebhookSignature checks header against the RAW request body. The
// signature is HMAC-SHA256 of "<t>.<body>" with the endpoint secret. Read the
// body bytes before any JSON decoding: re-encoded JSON never matches.
func VerifyWebhookSignature(header string, rawBody []byte, secret string, tolerance time.Duration, now time.Time) bool {
	if header == "" || secret == "" {
		return false
	}
	var timestamp string
	var signatures []string
	for _, part := range strings.Split(header, ",") {
		key, value, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		switch strings.TrimSpace(key) {
		case "t":
			timestamp = strings.TrimSpace(value)
		case "v1":
			signatures = append(signatures, strings.TrimSpace(value))
		}
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || len(signatures) == 0 {
		return false
	}
	age := now.Sub(time.Unix(seconds, 0))
	if age < 0 {
		age = -age
	}
	if age > tolerance {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(rawBody)
	expected := mac.Sum(nil)
	for _, signature := range signatures {
		received, err := hex.DecodeString(signature)
		// hmac.Equal is constant-time.
		if err == nil && hmac.Equal(received, expected) {
			return true
		}
	}
	return false
}

// ConstructWebhookEvent verifies the signature (with DefaultWebhookTolerance)
// and decodes the delivery.
func ConstructWebhookEvent(rawBody []byte, header, secret string) (*WebhookEvent, error) {
	if !VerifyWebhookSignature(header, rawBody, secret, DefaultWebhookTolerance, time.Now()) {
		return nil, ErrInvalidSignature
	}
	var event WebhookEvent
	if err := json.Unmarshal(rawBody, &event); err != nil {
		return nil, err
	}
	return &event, nil
}
