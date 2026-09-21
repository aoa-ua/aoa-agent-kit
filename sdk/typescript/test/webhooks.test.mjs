import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AoaWebhookSignatureError,
  constructWebhookEvent,
  verifyWebhookSignature,
} from '../dist/index.js';

const SECRET = 'whsec_test_secret_not_real';
const NOW = 1_800_000_000;
const BODY = JSON.stringify({
  id: 'd1',
  type: 'order.paid',
  createdAt: '2027-01-15T08:00:00.000Z',
  data: { paymentId: 'p1', status: 'SUCCESS', amountMinor: 90000 },
});

// Mirrors the server: HMAC-SHA256 over `${t}.${rawBody}`, hex.
const sign = (body, secret = SECRET, timestamp = NOW) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

const at = { now: NOW * 1000 };

describe('verifyWebhookSignature', () => {
  it('accepts a valid signature over a string or bytes', async () => {
    assert.equal(await verifyWebhookSignature(sign(BODY), BODY, SECRET, at), true);
    assert.equal(
      await verifyWebhookSignature(sign(BODY), new TextEncoder().encode(BODY), SECRET, at),
      true,
    );
  });

  it('rejects a tampered body, a wrong secret and garbage headers', async () => {
    assert.equal(await verifyWebhookSignature(sign(BODY), `${BODY} `, SECRET, at), false);
    assert.equal(await verifyWebhookSignature(sign(BODY, 'whsec_other'), BODY, SECRET, at), false);
    for (const header of [undefined, '', 't=abc,v1=00', `t=${NOW}`, `t=${NOW},v1=zz`, 'v1=00']) {
      assert.equal(await verifyWebhookSignature(header, BODY, SECRET, at), false, String(header));
    }
  });

  it('rejects signatures outside the tolerance window', async () => {
    const old = sign(BODY, SECRET, NOW - 301);
    assert.equal(await verifyWebhookSignature(old, BODY, SECRET, at), false);
    assert.equal(
      await verifyWebhookSignature(old, BODY, SECRET, { ...at, toleranceSeconds: 600 }),
      true,
    );
  });

  it('accepts when any of several v1 signatures matches', async () => {
    const valid = sign(BODY).split(',')[1];
    const header = `t=${NOW},v1=${'0'.repeat(64)},${valid}`;
    assert.equal(await verifyWebhookSignature(header, BODY, SECRET, at), true);
  });
});

describe('constructWebhookEvent', () => {
  it('returns the parsed event', async () => {
    const event = await constructWebhookEvent(BODY, sign(BODY), SECRET, at);
    assert.equal(event.type, 'order.paid');
    assert.equal(event.data.paymentId, 'p1');
  });

  it('throws on an invalid signature', async () => {
    await assert.rejects(
      () => constructWebhookEvent(BODY, sign(BODY, 'whsec_other'), SECRET, at),
      AoaWebhookSignatureError,
    );
  });
});
