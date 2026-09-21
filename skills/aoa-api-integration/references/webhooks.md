# AOA webhooks: full contract

Source of truth: https://aoa.com.ua/docs/webhooks/introduction,
https://aoa.com.ua/docs/webhooks/events and
https://aoa.com.ua/docs/webhooks/security.

## Managing endpoints

Scope `webhooks:write`, organization-scoped key.

| Call | Notes |
|---|---|
| `GET /webhooks` | list: `id`, `url`, `secretPrefix`, `events`, `isActive`, `failureCount`, `disabledAt`, `lastSuccessAt`, `createdAt` |
| `POST /webhooks` `{ url, events }` | returns `secret` ONCE; up to 10 endpoints per key (`409` above that) |
| `PATCH /webhooks/{id}` `{ isActive?, events? }` | `isActive: true` re-enables an auto-disabled endpoint and resets its failure counter; `events` replaces the list |
| `DELETE /webhooks/{id}` | deletes the endpoint and its secret immediately |

The URL must be `https` on port 443 or 8443 and resolve to a public address.
Private, loopback and link-local ranges are rejected at registration and
again before every delivery. Redirects are never followed: give the final
URL.

## Event types

| Type | Sent when |
|---|---|
| `order.paid` | the bank confirmed the payment; the attendee exists from now on |
| `order.failed` | payment declined or timed out |
| `order.refunded` | money returned, ticket voided |
| `event.cancelled` | the event is cancelled; all its tickets are void (can arrive weeks after the purchase) |
| `event.updated` | time or place changed |
| `attendee.registered` | registration for a free event (no payment) |
| `attendee.checked_in` | the guest passed check-in at the entrance |

## Delivery

```
POST <your url>
Content-Type: application/json
AOA-Signature: t=1800000000,v1=5f2a9c…(64 hex chars)
AOA-Delivery-Id: 3d9f7c21-…
AOA-Event-Type: order.paid
User-Agent: AOA-Webhooks/1.0

{
  "id": "3d9f7c21-…",
  "type": "order.paid",
  "createdAt": "2026-07-30T12:02:31.000Z",
  "data": {
    "paymentId": "d3f1a2b4-…",
    "eventId": "a1b2c3",
    "status": "SUCCESS",
    "amountMinor": 90000,
    "currency": "UAH",
    "attendeeId": "clx9attendee01"
  }
}
```

The envelope (`id`, `type`, `createdAt`, `data`) is the same for every type;
`data` depends on `type` (see the events page for each shape). `id` equals
`AOA-Delivery-Id`.

- Any `2xx` counts as delivered; the body of your response is ignored.
- Timeout per attempt: 10 seconds. Answer first, work afterwards.
- Retries after a failure: 1 min, 5 min, 30 min, 2 h, 6 h (6 attempts in
  total, about 9 hours). Keep processed delivery ids for a day to deduplicate.
- After 20 consecutive failed deliveries the endpoint is disabled
  (`isActive: false`, `disabledAt` set). Fix your server, then
  `PATCH /webhooks/{id}` with `{ "isActive": true }`.

## Verifying the signature

`v1` is HMAC-SHA256 of the string `"<t>.<raw body>"` keyed with the endpoint
secret (`whsec_…`), hex-encoded. The scheme matches Stripe's.

1. Read the raw body bytes. A framework that already parsed JSON and
   re-serializes it changes key order or whitespace and breaks the match.
2. Split the header on `,`, take `t` and every `v1`.
3. Reject when `|now - t|` is more than 300 seconds (replay protection).
4. Compute the HMAC and compare in constant time (`timingSafeEqual`,
   `hmac.compare_digest`, `hmac.Equal`), never with `==`.

With the SDKs:

```ts
import { constructWebhookEvent } from '@aoa-ua/sdk';

// Express: app.post('/hooks/aoa', express.raw({ type: 'application/json' }), handler)
const event = await constructWebhookEvent(
  req.body, // Buffer with the raw body
  req.get('AOA-Signature'),
  process.env.AOA_WEBHOOK_SECRET!,
);
```

```python
from aoa_sdk import construct_webhook_event

event = construct_webhook_event(request.body, request.headers["AOA-Signature"], secret)
```

```go
event, err := aoa.ConstructWebhookEvent(rawBody, r.Header.Get(aoa.SignatureHeader), secret)
```

Without an SDK (Node.js):

```js
import crypto from 'node:crypto';

export function verifyAoaSignature(header, rawBody, secret) {
  const parts = header.split(',');
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signature = parts.find((p) => p.startsWith('v1='))?.slice(3);
  if (!timestamp || !signature) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

If a secret leaks: delete the endpoint and register it again. The old secret
stops working at once.
