package aoa

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// APIError is an error response of the AOA API:
// {"error": {"code", "message", "hint"}}.
//
// Branch on Code, never on Message: messages are meant for people and some
// are in Ukrainian. A response outside this envelope (for example an HTML
// page from a proxy) gets Code "http_<status>".
type APIError struct {
	StatusCode int
	// Code is stable: bad_request, unauthorized, forbidden, not_found, gone,
	// conflict, rate_limited, internal_error.
	Code    string
	Message string
	// Hint says what to do next to fix the request, when the API knows.
	Hint      string
	RateLimit *RateLimit
	Body      []byte
}

func (e *APIError) Error() string {
	text := fmt.Sprintf("aoa: %d %s: %s", e.StatusCode, e.Code, e.Message)
	if e.Hint != "" {
		text += " (hint: " + e.Hint + ")"
	}
	return text
}

// Retryable reports whether a later identical request may succeed:
// rate_limited (wait Retry-After) and internal_error (back off). Retry
// writes only with the same Idempotency-Key.
func (e *APIError) Retryable() bool {
	return e.Code == "rate_limited" || e.Code == "internal_error"
}

func errorFromResponse(status int, statusLine string, body []byte, rateLimit *RateLimit) *APIError {
	var envelope struct {
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Hint    string `json:"hint"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && envelope.Error != nil && envelope.Error.Code != "" {
		return &APIError{
			StatusCode: status,
			Code:       envelope.Error.Code,
			Message:    envelope.Error.Message,
			Hint:       envelope.Error.Hint,
			RateLimit:  rateLimit,
			Body:       body,
		}
	}
	message := strings.TrimSpace(strings.TrimPrefix(statusLine, fmt.Sprint(status)))
	if message == "" {
		message = http.StatusText(status)
	}
	return &APIError{
		StatusCode: status,
		Code:       fmt.Sprintf("http_%d", status),
		Message:    message,
		RateLimit:  rateLimit,
		Body:       body,
	}
}
