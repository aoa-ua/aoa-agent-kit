package aoa

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
)

const webhookSecret = "whsec_test_secret_not_real"

var (
	webhookNow  = time.Unix(1_800_000_000, 0)
	webhookBody = []byte(`{"id":"d1","type":"order.paid","createdAt":"2027-01-15T08:00:00.000Z","data":{"paymentId":"p1","status":"SUCCESS","amountMinor":90000}}`)
)

// sign mirrors the server: HMAC-SHA256 over "<t>.<rawBody>", hex.
func sign(body []byte, secret string, at time.Time) string {
	timestamp := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(body)
	return "t=" + timestamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyWebhookSignature(t *testing.T) {
	valid := sign(webhookBody, webhookSecret, webhookNow)
	if !VerifyWebhookSignature(valid, webhookBody, webhookSecret, DefaultWebhookTolerance, webhookNow) {
		t.Fatal("valid signature rejected")
	}
	tampered := append(append([]byte{}, webhookBody...), ' ')
	if VerifyWebhookSignature(valid, tampered, webhookSecret, DefaultWebhookTolerance, webhookNow) {
		t.Fatal("tampered body accepted")
	}
	if VerifyWebhookSignature(sign(webhookBody, "whsec_other", webhookNow), webhookBody, webhookSecret, DefaultWebhookTolerance, webhookNow) {
		t.Fatal("wrong secret accepted")
	}
	for _, header := range []string{"", "t=abc,v1=00", "t=1800000000", "v1=00", "t=1800000000,v1=zz"} {
		if VerifyWebhookSignature(header, webhookBody, webhookSecret, DefaultWebhookTolerance, webhookNow) {
			t.Fatalf("garbage header accepted: %q", header)
		}
	}
}

func TestVerifyWebhookTolerance(t *testing.T) {
	old := sign(webhookBody, webhookSecret, webhookNow.Add(-301*time.Second))
	if VerifyWebhookSignature(old, webhookBody, webhookSecret, DefaultWebhookTolerance, webhookNow) {
		t.Fatal("stale signature accepted")
	}
	if !VerifyWebhookSignature(old, webhookBody, webhookSecret, 10*time.Minute, webhookNow) {
		t.Fatal("signature inside a wider window rejected")
	}
}

func TestVerifyWebhookAnyV1(t *testing.T) {
	valid := sign(webhookBody, webhookSecret, webhookNow)
	parts := strings.SplitN(valid, ",", 2)
	header := parts[0] + ",v1=" + strings.Repeat("0", 64) + "," + parts[1]
	if !VerifyWebhookSignature(header, webhookBody, webhookSecret, DefaultWebhookTolerance, webhookNow) {
		t.Fatal("matching second v1 rejected")
	}
}

func TestConstructWebhookEvent(t *testing.T) {
	now := time.Now()
	event, err := ConstructWebhookEvent(webhookBody, sign(webhookBody, webhookSecret, now), webhookSecret)
	if err != nil {
		t.Fatal(err)
	}
	if event.Type != EventOrderPaid || event.ID != "d1" {
		t.Fatalf("event = %+v", event)
	}
	var data struct {
		PaymentID string `json:"paymentId"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil || data.PaymentID != "p1" {
		t.Fatalf("data = %s", event.Data)
	}
	if _, err := ConstructWebhookEvent(webhookBody, sign(webhookBody, "whsec_other", now), webhookSecret); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("err = %v", err)
	}
}
