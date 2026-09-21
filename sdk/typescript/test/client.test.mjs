import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  AoaApiError,
  AoaTimeoutError,
  createAoaClient,
  OPERATIONS,
  parseRateLimit,
  SDK_VERSION,
} from '../dist/index.js';
import { mockFetch, TEST_KEY } from './helpers.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RATE_HEADERS = {
  'Content-Type': 'application/json',
  'RateLimit-Policy': '"default";q=60;w=60',
  RateLimit: '"default";r=59;t=60',
  'X-RateLimit-Limit': '60',
  'X-RateLimit-Remaining': '59',
};

describe('client surface', () => {
  it('exposes one function per operation in the spec', () => {
    const client = createAoaClient({ fetch: async () => new Response('{}') });
    const operationIds = Object.keys(OPERATIONS);
    assert.equal(operationIds.length >= 15, true);
    for (const operationId of operationIds) {
      assert.equal(typeof client[operationId], 'function', operationId);
    }
  });

  it('keeps SDK_VERSION equal to package.json', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    assert.equal(SDK_VERSION, pkg.version);
  });
});

describe('reads', () => {
  it('searchEvents builds the query and needs no key', async () => {
    const { fetch, calls } = mockFetch({
      body: { data: [{ id: 'a1b2c3', title: 'Jazz' }], meta: { count: 1 } },
      headers: RATE_HEADERS,
    });
    const client = createAoaClient({ fetch, apiKey: '' });
    const result = await client.searchEvents({ city: 'Київ', limit: 5 });

    assert.deepEqual(result.data, [{ id: 'a1b2c3', title: 'Jazz' }]);
    const [call] = calls;
    assert.equal(call.method, 'GET');
    assert.equal(call.url.origin + call.url.pathname, 'https://aoa.com.ua/api/v1/events');
    assert.equal(call.url.searchParams.get('city'), 'Київ');
    assert.equal(call.url.searchParams.get('limit'), '5');
    assert.equal(call.headers.get('authorization'), null);
    assert.equal(call.headers.get('accept'), 'application/json');
    assert.match(call.headers.get('user-agent'), /^aoa-sdk-typescript\//);
    assert.deepEqual(client.rateLimit, {
      limit: 60,
      remaining: 59,
      resetSeconds: 60,
      windowSeconds: 60,
    });
  });

  it('sends the key on reads when configured (higher limit)', async () => {
    const { fetch, calls } = mockFetch({ body: { data: [] } });
    const client = createAoaClient({ fetch, apiKey: TEST_KEY });
    await client.searchLocations();
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${TEST_KEY}`);
  });

  it('encodes path params and rejects missing ones', async () => {
    const { fetch, calls } = mockFetch({ body: { data: { id: 'x' } } });
    const client = createAoaClient({ fetch });
    await client.getEvent({ eventId: 'a b/c' });
    assert.equal(calls[0].url.pathname, '/api/v1/events/a%20b%2Fc');
    await assert.rejects(() => client.getEvent({}), TypeError);
    assert.equal(calls.length, 1);
  });

  it('getTableAvailability sends date as query', async () => {
    const { fetch, calls } = mockFetch({ body: { data: { reason: 'ok' } } });
    const client = createAoaClient({ fetch });
    await client.getTableAvailability({ locationId: 'loc1', date: '2026-10-01' });
    assert.equal(calls[0].url.pathname, '/api/v1/locations/loc1/availability');
    assert.equal(calls[0].url.searchParams.get('date'), '2026-10-01');
  });

  it('passes undeclared params of GET operations as query', async () => {
    const { fetch, calls } = mockFetch({ body: { data: [] } });
    const client = createAoaClient({ fetch });
    await client.request('searchEvents', { city: 'Львів', newServerParam: 'x' });
    assert.equal(calls[0].url.searchParams.get('newServerParam'), 'x');
  });

  it('uses a custom baseUrl without a trailing slash', async () => {
    const { fetch, calls } = mockFetch({ body: { data: [] } });
    const client = createAoaClient({ fetch, baseUrl: 'http://localhost:3000/api/v1/' });
    await client.searchLocations({ bookable: false });
    assert.equal(calls[0].url.href, 'http://localhost:3000/api/v1/locations?bookable=false');
  });
});

describe('writes', () => {
  const checkoutParams = {
    eventId: 'a1b2c3',
    tickets: [{ ticketTypeId: 'tt1', quantity: 2 }],
    buyer: { email: 'buyer@example.com', name: 'Test Buyer' },
  };

  it('refuses write operations without a key before any request', async () => {
    const { fetch, calls } = mockFetch({ body: { data: {} } });
    const client = createAoaClient({ fetch, apiKey: '' });
    await assert.rejects(() => client.createTicketCheckout(checkoutParams), /API key/);
    await assert.rejects(() => client.getOrder({ paymentId: 'p1' }), /API key/);
    assert.equal(calls.length, 0);
  });

  it('createTicketCheckout sends JSON body, auth and a generated Idempotency-Key', async () => {
    const { fetch, calls } = mockFetch({
      body: { data: { paymentId: 'p1', paymentUrl: 'https://pay.example/p1' } },
    });
    const client = createAoaClient({ fetch, apiKey: TEST_KEY, agentProvider: 'my-agent' });
    const result = await client.createTicketCheckout(checkoutParams);

    assert.equal(result.data.paymentUrl, 'https://pay.example/p1');
    const [call] = calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url.pathname, '/api/v1/checkout');
    assert.deepEqual(call.body, checkoutParams);
    assert.equal(call.headers.get('content-type'), 'application/json');
    assert.equal(call.headers.get('authorization'), `Bearer ${TEST_KEY}`);
    assert.equal(call.headers.get('x-agent-provider'), 'my-agent');
    assert.match(call.headers.get('idempotency-key'), UUID);
  });

  it('uses the caller Idempotency-Key when given', async () => {
    const { fetch, calls } = mockFetch({ body: { data: { reservationId: 'r1' } } });
    const client = createAoaClient({ fetch, apiKey: TEST_KEY });
    await client.createTableReservation(
      {
        locationId: 'loc1',
        date: '2026-10-01',
        time: '19:00',
        partySize: 2,
        guest: { name: 'Guest Typed Name', phone: '+380000000000' },
        confirmedByUser: true,
      },
      { idempotencyKey: 'cart-42-booking' },
    );
    assert.equal(calls[0].url.pathname, '/api/v1/table-reservations');
    assert.equal(calls[0].headers.get('idempotency-key'), 'cart-42-booking');
    assert.equal(calls[0].body.confirmedByUser, true);
  });

  it('does not invent an Idempotency-Key where the spec has none', async () => {
    const { fetch, calls } = mockFetch({ body: { data: { reservationId: 'r1' } } });
    const client = createAoaClient({ fetch, apiKey: TEST_KEY });
    await client.createTicketReservation({
      eventId: 'a1b2c3',
      tickets: [{ ticketTypeId: 'tt1', quantity: 1 }],
    });
    assert.equal(calls[0].url.pathname, '/api/v1/reservations');
    assert.equal(calls[0].headers.get('idempotency-key'), null);
  });

  it('webhook management uses the right verbs and paths', async () => {
    const { fetch, calls } = mockFetch({ body: { data: {} } });
    const client = createAoaClient({ fetch, apiKey: TEST_KEY });
    await client.listWebhooks();
    await client.createWebhook({ url: 'https://example.com/hooks/aoa', events: ['order.paid'] });
    await client.updateWebhook({ endpointId: 'wh1', isActive: true });
    await client.deleteWebhook({ endpointId: 'wh1' });

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url.pathname}`),
      [
        'GET /api/v1/webhooks',
        'POST /api/v1/webhooks',
        'PATCH /api/v1/webhooks/wh1',
        'DELETE /api/v1/webhooks/wh1',
      ],
    );
    assert.deepEqual(calls[2].body, { isActive: true });
    assert.equal(calls[3].body, undefined);
  });
});

describe('batch and async checkout', () => {
  it('batchOperations posts the operations list without a key', async () => {
    const { fetch, calls } = mockFetch({
      body: { data: [{ id: 'a', status: 200, body: { data: {} } }] },
    });
    const client = createAoaClient({ fetch, apiKey: '' });
    const result = await client.batchOperations({
      operations: [{ id: 'a', path: '/events/e1/availability' }],
    });
    assert.equal(result.data[0].status, 200);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url.pathname, '/api/v1/batch');
    assert.deepEqual(calls[0].body, {
      operations: [{ id: 'a', path: '/events/e1/availability' }],
    });
  });

  it('forwards Prefer: respond-async and returns the 202 body', async () => {
    const { fetch, calls } = mockFetch({
      status: 202,
      body: {
        data: {
          paymentId: 'p1',
          paymentUrl: 'https://pay.example/p1',
          status: 'PENDING',
          statusUrl: 'https://aoa.com.ua/api/v1/orders/p1',
        },
      },
      headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
    });
    const client = createAoaClient({ fetch, apiKey: TEST_KEY });
    const result = await client.createTicketCheckout(
      {
        eventId: 'e1',
        tickets: [{ ticketTypeId: 'tt1', quantity: 1 }],
        buyer: { email: 'buyer@example.com', name: 'Test Buyer' },
      },
      { headers: { Prefer: 'respond-async' } },
    );
    assert.equal(calls[0].headers.get('prefer'), 'respond-async');
    assert.equal(result.data.statusUrl, 'https://aoa.com.ua/api/v1/orders/p1');
  });
});

describe('errors and retries', () => {
  it('maps the error envelope to AoaApiError', async () => {
    const { fetch } = mockFetch({
      status: 404,
      body: { error: { code: 'not_found', message: 'Event not found', hint: 'Check the id' } },
    });
    const client = createAoaClient({ fetch });
    await assert.rejects(
      () => client.getEvent({ eventId: 'missing' }),
      (error) => {
        assert.ok(error instanceof AoaApiError);
        assert.equal(error.status, 404);
        assert.equal(error.code, 'not_found');
        assert.equal(error.message, 'Event not found');
        assert.equal(error.hint, 'Check the id');
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it('handles a non-JSON error body', async () => {
    const { fetch } = mockFetch({
      status: 502,
      statusText: 'Bad Gateway',
      body: '<html>bad gateway</html>',
      headers: { 'Content-Type': 'text/html' },
    });
    const client = createAoaClient({ fetch });
    await assert.rejects(
      () => client.searchEvents(),
      (error) => error instanceof AoaApiError && error.code === 'http_502' && error.status === 502,
    );
  });

  it('does not retry 429 by default and exposes Retry-After', async () => {
    const { fetch, calls } = mockFetch({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'Too many requests' } },
      headers: { ...RATE_HEADERS, RateLimit: '"default";r=0;t=42', 'Retry-After': '42' },
    });
    const client = createAoaClient({ fetch });
    await assert.rejects(
      () => client.searchEvents(),
      (error) =>
        error.code === 'rate_limited' &&
        error.retryable === true &&
        error.rateLimit.retryAfterSeconds === 42,
    );
    assert.equal(calls.length, 1);
  });

  it('retries 429 when enabled, reusing the same Idempotency-Key', async () => {
    const { fetch, calls } = mockFetch(
      {
        status: 429,
        body: { error: { code: 'rate_limited', message: 'Too many requests' } },
        headers: { 'Retry-After': '0' },
      },
      { body: { data: { paymentId: 'p1', paymentUrl: 'https://pay.example/p1' } } },
    );
    const client = createAoaClient({ fetch, apiKey: TEST_KEY, maxRetries: 2 });
    const result = await client.createTicketCheckout({
      eventId: 'e1',
      tickets: [{ ticketTypeId: 'tt1', quantity: 1 }],
      buyer: { email: 'buyer@example.com', name: 'Test Buyer' },
    });
    assert.equal(result.data.paymentId, 'p1');
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].headers.get('idempotency-key'),
      calls[1].headers.get('idempotency-key'),
    );
  });

  it('gives up when Retry-After exceeds maxRetryDelayMs', async () => {
    const { fetch, calls } = mockFetch({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'Too many requests' } },
      headers: { 'Retry-After': '600' },
    });
    const client = createAoaClient({ fetch, maxRetries: 3, maxRetryDelayMs: 1000 });
    await assert.rejects(() => client.searchEvents(), AoaApiError);
    assert.equal(calls.length, 1);
  });

  it('times out a hanging request', async () => {
    const fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const client = createAoaClient({ fetch, timeoutMs: 20 });
    await assert.rejects(() => client.searchEvents(), AoaTimeoutError);
  });

  it('honours a caller AbortSignal', async () => {
    const fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const client = createAoaClient({ fetch });
    const controller = new AbortController();
    const pending = client.searchEvents({}, { signal: controller.signal });
    controller.abort(new Error('stop'));
    await assert.rejects(pending, /stop/);
  });
});

describe('pagination', () => {
  it('follows meta.nextCursor until it is null', async () => {
    const { fetch, calls } = mockFetch(
      { body: { data: [{ id: 1 }, { id: 2 }], meta: { nextCursor: 'c2', hasMore: true } } },
      { body: { data: [{ id: 3 }], meta: { nextCursor: null, hasMore: false } } },
    );
    const client = createAoaClient({ fetch });
    const ids = [];
    for await (const event of client.paginate('searchEvents', { city: 'Київ' })) {
      ids.push(event.id);
    }
    assert.deepEqual(ids, [1, 2, 3]);
    assert.equal(calls[0].url.searchParams.get('cursor'), null);
    assert.equal(calls[1].url.searchParams.get('cursor'), 'c2');
    assert.equal(calls[1].url.searchParams.get('city'), 'Київ');
  });

  it('stops after one page when the server does not paginate', async () => {
    const { fetch, calls } = mockFetch({ body: { data: [{ id: 1 }] } });
    const client = createAoaClient({ fetch });
    const items = [];
    for await (const item of client.paginate('searchLocations')) items.push(item);
    assert.equal(items.length, 1);
    assert.equal(calls.length, 1);
  });
});

describe('parseRateLimit', () => {
  it('returns null without headers and reads the X- fallbacks', () => {
    assert.equal(parseRateLimit(new Headers()), null);
    assert.deepEqual(
      parseRateLimit(new Headers({ 'X-RateLimit-Limit': '600', 'X-RateLimit-Remaining': '10' })),
      { limit: 600, remaining: 10 },
    );
  });

  it('parses an HTTP-date Retry-After', () => {
    const now = Date.parse('2026-09-21T12:00:00Z');
    const info = parseRateLimit(
      new Headers({ 'Retry-After': 'Mon, 21 Sep 2026 12:00:30 GMT' }),
      now,
    );
    assert.equal(info.retryAfterSeconds, 30);
  });
});
