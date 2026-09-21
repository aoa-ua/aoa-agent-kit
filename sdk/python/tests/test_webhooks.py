import hashlib
import hmac
import json
import unittest

from aoa_sdk import WebhookSignatureError, construct_webhook_event, verify_webhook_signature

SECRET = "whsec_test_secret_not_real"
NOW = 1_800_000_000
BODY = json.dumps(
    {
        "id": "d1",
        "type": "order.paid",
        "createdAt": "2027-01-15T08:00:00.000Z",
        "data": {"paymentId": "p1", "status": "SUCCESS", "amountMinor": 90000},
    }
).encode("utf-8")


def sign(body: bytes, secret: str = SECRET, timestamp: int = NOW) -> str:
    # Mirrors the server: HMAC-SHA256 over f"{t}.{raw_body}", hex.
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


class VerifyTests(unittest.TestCase):
    def test_valid_signature(self) -> None:
        self.assertTrue(verify_webhook_signature(sign(BODY), BODY, SECRET, now=NOW))
        self.assertTrue(verify_webhook_signature(sign(BODY), BODY.decode(), SECRET, now=NOW))

    def test_rejects_tampering_and_garbage(self) -> None:
        self.assertFalse(verify_webhook_signature(sign(BODY), BODY + b" ", SECRET, now=NOW))
        self.assertFalse(verify_webhook_signature(sign(BODY, "whsec_other"), BODY, SECRET, now=NOW))
        for header in (None, "", "t=abc,v1=00", f"t={NOW}", "v1=00"):
            self.assertFalse(verify_webhook_signature(header, BODY, SECRET, now=NOW), header)

    def test_tolerance_window(self) -> None:
        old = sign(BODY, timestamp=NOW - 301)
        self.assertFalse(verify_webhook_signature(old, BODY, SECRET, now=NOW))
        self.assertTrue(verify_webhook_signature(old, BODY, SECRET, tolerance_seconds=600, now=NOW))

    def test_any_matching_v1(self) -> None:
        valid = sign(BODY).split(",")[1]
        header = f"t={NOW},v1={'0' * 64},{valid}"
        self.assertTrue(verify_webhook_signature(header, BODY, SECRET, now=NOW))


class ConstructTests(unittest.TestCase):
    def test_returns_event(self) -> None:
        event = construct_webhook_event(BODY, sign(BODY), SECRET, now=NOW)
        self.assertEqual(event["type"], "order.paid")
        self.assertEqual(event["data"]["paymentId"], "p1")

    def test_raises_on_bad_signature(self) -> None:
        with self.assertRaises(WebhookSignatureError):
            construct_webhook_event(BODY, sign(BODY, "whsec_other"), SECRET, now=NOW)


if __name__ == "__main__":
    unittest.main()
