package aoa

import (
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// RateLimit is parsed from response headers. A nil field means the header was
// absent. AOA sends RateLimit-Policy ("default";q=60;w=60), RateLimit
// ("default";r=59;t=60), X-RateLimit-Limit / X-RateLimit-Remaining, and
// Retry-After with 429.
type RateLimit struct {
	// Limit is requests per window (q or X-RateLimit-Limit).
	Limit *int
	// Remaining is requests left in the window (r or X-RateLimit-Remaining).
	Remaining *int
	// ResetSeconds is the upper bound until the quota refills (t).
	ResetSeconds *int
	// WindowSeconds is the window length (w).
	WindowSeconds *int
	// RetryAfterSeconds is Retry-After: the wait before retrying a 429, or the
	// polling interval of a 202 from an asynchronous checkout.
	RetryAfterSeconds *int
}

func parseInt(value string) *int {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return nil
	}
	n := int(parsed)
	return &n
}

func structuredParams(value string) map[string]string {
	params := map[string]string{}
	parts := strings.Split(value, ";")
	for _, part := range parts[1:] {
		key, raw, found := strings.Cut(part, "=")
		if found {
			params[strings.TrimSpace(key)] = strings.TrimSpace(raw)
		}
	}
	return params
}

func parseRetryAfter(value string, now time.Time) *int {
	if value == "" {
		return nil
	}
	if seconds := parseInt(value); seconds != nil {
		if *seconds < 0 {
			zero := 0
			return &zero
		}
		return seconds
	}
	moment, err := http.ParseTime(value)
	if err != nil {
		return nil
	}
	seconds := int(math.Max(0, math.Ceil(moment.Sub(now).Seconds())))
	return &seconds
}

func firstNonNil(values ...*int) *int {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func parseRateLimit(header http.Header, now time.Time) *RateLimit {
	policy := structuredParams(header.Get("RateLimit-Policy"))
	state := structuredParams(header.Get("RateLimit"))
	info := &RateLimit{
		Limit:             firstNonNil(parseInt(policy["q"]), parseInt(header.Get("X-RateLimit-Limit"))),
		Remaining:         firstNonNil(parseInt(state["r"]), parseInt(header.Get("X-RateLimit-Remaining"))),
		ResetSeconds:      parseInt(state["t"]),
		WindowSeconds:     parseInt(policy["w"]),
		RetryAfterSeconds: parseRetryAfter(header.Get("Retry-After"), now),
	}
	if info.Limit == nil && info.Remaining == nil && info.ResetSeconds == nil &&
		info.WindowSeconds == nil && info.RetryAfterSeconds == nil {
		return nil
	}
	return info
}
