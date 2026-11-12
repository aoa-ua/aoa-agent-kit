import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_VERSION, formatOpeningHours, run } from '../src/cli.mjs';
import packageJson from '../package.json' with { type: 'json' };

/** Fake fetch answering from one spec; records the calls. */
const fakeFetch = (spec) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: new URL(url), method: init.method, headers: init.headers, body: init.body });
    const { status = 200, body = {} } = typeof spec === 'function' ? spec(url) : spec;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, calls };
};

const cli = async (argv, spec = { body: { data: [] } }, env = {}) => {
  const { fetch, calls } = fakeFetch(spec);
  const out = [];
  const err = [];
  const code = await run(argv, {
    fetch,
    env,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), calls };
};

test('version matches package.json', async () => {
  assert.equal(CLI_VERSION, packageJson.version);
  assert.equal((await cli(['--version'])).out, packageJson.version);
});

test('no command prints help and exits 2; --help exits 0', async () => {
  const bare = await cli([]);
  assert.equal(bare.code, 2);
  assert.match(bare.out, /Usage: aoa <command>/);
  assert.equal((await cli(['--help'])).code, 0);
});

test('venues: query and filters go to /locations, reads send no key', async () => {
  const { code, out, calls } = await cli(['venues', 'кава', '--city', 'Київ', '--limit', '3'], {
    body: {
      data: [
        { id: 'v1', name: 'Кавʼярня', address: 'вул. Хрещатик, 1', city: 'Київ', reservationsEnabled: true },
      ],
    },
  });
  assert.equal(code, 0);
  const url = calls[0].url;
  assert.equal(url.origin + url.pathname, 'https://aoa.com.ua/api/v1/locations');
  assert.equal(url.searchParams.get('query'), 'кава');
  assert.equal(url.searchParams.get('city'), 'Київ');
  assert.equal(url.searchParams.get('bookable'), 'false');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.match(out, /v1 {2}Кавʼярня {2}\(вул\. Хрещатик, 1, Київ\) {2}\[bookable\]/);
});

test('--sandbox switches the base URL; AOA_API_KEY is sent as Bearer', async () => {
  const { calls } = await cli(['events', '--sandbox'], undefined, {
    AOA_API_KEY: 'aoa_test_1234567890abcdef',
  });
  assert.equal(calls[0].url.href, 'https://aoa.com.ua/api/sandbox/v1/events');
  assert.equal(calls[0].headers.Authorization, 'Bearer aoa_test_1234567890abcdef');
});

test('tables needs --date and prints free slots only', async () => {
  assert.equal((await cli(['tables', 'v1'])).code, 2);
  const { out, calls } = await cli(['tables', 'v1', '--date', '2026-11-14'], {
    body: {
      data: {
        locationId: 'v1',
        date: '2026-11-14',
        reason: 'ok',
        maxGuests: 6,
        slots: [
          { value: '18:00', label: '18:00', available: false },
          { value: '19:00', label: '19:00', available: true },
        ],
      },
    },
  });
  assert.equal(calls[0].url.pathname, '/api/v1/locations/v1/availability');
  assert.equal(out, '2026-11-14, up to 6 guests: 19:00');
});

test('path arguments are URL-encoded', async () => {
  const { calls } = await cli(['event', '../admin'], { body: { data: { ticketTypes: [] } } });
  assert.equal(calls[0].url.pathname, '/api/v1/events/..%2Fadmin');
});

test('API errors print code, message and hint, exit 1', async () => {
  const { code, err } = await cli(['event', 'NOPE'], {
    status: 404,
    body: { error: { code: 'not_found', message: 'Event not found', hint: 'Use aoa events' } },
  });
  assert.equal(code, 1);
  assert.equal(err, 'not_found: Event not found\nHint: Use aoa events');
});

test('--json prints the raw response for scripts and agents', async () => {
  const body = { data: [], meta: { count: 0, hasMore: false } };
  const { out } = await cli(['events', '--json'], { body });
  assert.deepEqual(JSON.parse(out), body);
});

test('api POST sends JSON body and an idempotency key', async () => {
  const { code, calls } = await cli(
    ['api', 'post', '/reservations', '--data', '{"eventId":"E1"}', '--idempotency-key', 'order-42'],
    { body: { data: { id: 'h1' } } },
    { AOA_API_KEY: 'aoa_test_1234567890abcdef' },
  );
  assert.equal(code, 0);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, '{"eventId":"E1"}');
  assert.equal(calls[0].headers['Idempotency-Key'], 'order-42');
  assert.equal((await cli(['api', 'POST', '/x', '--data', '{bad'])).code, 2);
});

test('network failure is reported, not thrown', async () => {
  const code = await run(['events'], {
    fetch: async () => {
      throw new Error('offline');
    },
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(code, 1);
});

test('opening hours collapse to "daily" when every day matches', () => {
  const week = Object.fromEntries(
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => [
      day,
      { open: '10:00', close: '23:00' },
    ]),
  );
  assert.equal(formatOpeningHours(JSON.stringify(week)), 'daily 10:00-23:00');
  week.sunday = null;
  assert.match(formatOpeningHours(week), /Sat 10:00-23:00, Sun closed$/);
});
