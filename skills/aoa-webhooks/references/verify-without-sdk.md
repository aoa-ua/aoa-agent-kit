# Verifying AOA-Signature without an SDK

Source: https://aoa.com.ua/docs/webhooks/security

```
AOA-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
```

1. Read the raw request body bytes. Do not parse JSON first.
2. Split the header on `,`, take `t` and `v1`.
3. Reject when `|now - t|` is more than 300 seconds (replay protection).
4. Compute HMAC-SHA256 of `"<t>.<raw body>"` keyed with the endpoint secret
   (`whsec_…`, the whole string), hex-encode it.
5. Compare with `v1` in constant time (`crypto.timingSafeEqual`,
   `hmac.compare_digest`, `hmac.Equal`), never with `==`.
6. Only then parse the JSON.

## Getting the raw body

| Stack | Raw body |
|---|---|
| Fetch API (Next.js route handlers, Bun, Deno, workers) | `await request.text()` |
| Express | `express.raw({ type: 'application/json' })` on the route, then `req.body` (a Buffer); not `express.json()` |
| Flask | `request.get_data()` |
| FastAPI, Starlette | `await request.body()` |
| Go `net/http` | `io.ReadAll(r.Body)` |

## Node.js

```js
import crypto from 'node:crypto';

const TOLERANCE_SECONDS = 300;

export function verifyAoaSignature(header, rawBody, secret) {
  const parts = header.split(',');
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signature = parts.find((p) => p.startsWith('v1='))?.slice(3);
  if (!timestamp || !signature) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

## Python

```python
import hashlib, hmac, time

TOLERANCE_SECONDS = 300

def verify_aoa_signature(header: str, raw_body: bytes, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    timestamp, signature = parts.get("t"), parts.get("v1")
    if not timestamp or not signature:
        return False
    if abs(int(time.time()) - int(timestamp)) > TOLERANCE_SECONDS:
        return False
    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)
```

## Testing your handler

Sign a fixture yourself with the same scheme and a test secret, then send it
to your handler. Never use a real secret in tests.

```js
import crypto from 'node:crypto';

const secret = 'whsec_test_only';
const body = JSON.stringify({
  id: 'test-delivery-1',
  type: 'order.paid',
  createdAt: new Date().toISOString(),
  data: { paymentId: 'test-payment', eventId: 'TEST01', status: 'SUCCESS', amountMinor: 10000, currency: 'UAH', attendeeId: null },
});
const t = Math.floor(Date.now() / 1000);
const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
const headers = { 'Content-Type': 'application/json', 'AOA-Signature': `t=${t},v1=${v1}`, 'AOA-Delivery-Id': 'test-delivery-1', 'AOA-Event-Type': 'order.paid' };
```

Cover at least: a valid signature, a changed body (must fail), a `t` older
than 300 seconds (must fail), and the same `AOA-Delivery-Id` twice (second one
skipped). The SDK helpers take a fixed current time for such tests: `now` in
TypeScript options, `now=` in Python, the `now` argument of
`VerifyWebhookSignature` in Go.
