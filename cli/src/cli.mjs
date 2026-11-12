/**
 * `aoa`: command-line client for the AOA public API (https://aoa.com.ua).
 *
 * Zero dependencies on purpose: `npx @aoa-ua/cli venues` has to start in a
 * second, in CI, in a coding agent's sandbox. Node 20+ gives us `fetch` and
 * `parseArgs`, which is everything a thin REST client needs.
 *
 * `run()` takes its I/O as arguments and returns an exit code, so tests drive
 * it with a fake fetch and capture output without spawning a process.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

export const CLI_VERSION = '0.1.0';

const LIVE_BASE_URL = 'https://aoa.com.ua/api/v1';
const SANDBOX_BASE_URL = 'https://aoa.com.ua/api/sandbox/v1';
const USER_AGENT = `aoa-cli/${CLI_VERSION}`;

/** Exit codes: 0 ok, 1 API or network error, 2 wrong usage. */
const EXIT_OK = 0;
const EXIT_API_ERROR = 1;
const EXIT_USAGE = 2;

const GLOBAL_OPTIONS = {
  json: { type: 'boolean', default: false },
  sandbox: { type: 'boolean', default: false },
  'base-url': { type: 'string' },
  'api-key': { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const HELP = `aoa ${CLI_VERSION}: the AOA public API from your terminal (https://aoa.com.ua)

Usage: aoa <command> [arguments] [options]

Venues and tables
  venues [query]             Search venues        --city <name> --bookable --limit <n> --cursor <c>
  venue <venueId>            Venue details: address, hours, phone, bookings
  tables <venueId>           Free table slots     --date <YYYY-MM-DD> (required)

Events and tickets
  events                     Upcoming events      --city <name> --category <slug> --limit <n> --cursor <c>
  event <eventId>            Event details, ticket types and refund policy
  tickets <eventId>          Live ticket availability per ticket type

Account (partner API key)
  order <paymentId>          Order (payment) status
  api <METHOD> <path>        Any operation from /openapi.json
                             --data <json> --idempotency-key <key>

Options
  --json                     Print the raw JSON response (for scripts and agents)
  --sandbox                  Use the sandbox: test data, no real bookings or payments
  --api-key <key>            Partner key; defaults to $AOA_API_KEY. Reads need none
  --base-url <url>           Override the API base URL
  -h, --help                 Show this help
  -v, --version              Show the version

Reads work without a key (60 requests per minute per IP). Bookings, checkout
and webhooks need a partner key; in the sandbox any self-made aoa_test_<16+
characters> key works. Every booking and purchase must be confirmed by the
person it is for.

Docs: https://aoa.com.ua/docs/api-reference/introduction
OpenAPI: https://aoa.com.ua/openapi.json`;

class UsageError extends Error {}

const DAYS = [
  ['monday', 'Mon'],
  ['tuesday', 'Tue'],
  ['wednesday', 'Wed'],
  ['thursday', 'Thu'],
  ['friday', 'Fri'],
  ['saturday', 'Sat'],
  ['sunday', 'Sun'],
];

/** `{"monday":{"open":"10:00","close":"23:00"},…}` → "daily 10:00-23:00". */
export const formatOpeningHours = (raw) => {
  let hours = raw;
  if (typeof raw === 'string') {
    try {
      hours = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (!hours || typeof hours !== 'object') return null;
  const slots = DAYS.map(([day]) => {
    const slot = hours[day];
    return slot?.open && slot?.close ? `${slot.open}-${slot.close}` : 'closed';
  });
  if (slots.every((slot) => slot === slots[0])) return `daily ${slots[0]}`;
  return slots.map((slot, index) => `${DAYS[index][1]} ${slot}`).join(', ');
};

const formatDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Europe/Kyiv',
      })
    : 'date TBA';

const price = (item) =>
  item.isFree ? 'free' : `${item.priceDecimal} ${item.currency}`;

const join = (parts) => parts.filter(Boolean).join(', ');

/** Human-readable output per command. `--json` bypasses all of this. */
const FORMATTERS = {
  venues: (data) =>
    data.length === 0
      ? 'No venues found.'
      : data
          .map(
            (venue) =>
              `${venue.id}  ${venue.name}  (${join([venue.address, venue.city])})` +
              `${venue.reservationsEnabled ? '  [bookable]' : ''}`,
          )
          .join('\n'),
  venue: (venue) =>
    [
      `${venue.name}  [${venue.id}]`,
      `Address: ${join([venue.address, venue.city]) || 'not specified'}`,
      venue.openingHours ? `Hours: ${formatOpeningHours(venue.openingHours)}` : null,
      venue.phone ? `Phone: ${venue.phone}` : null,
      venue.reservationsEnabled
        ? `Table bookings: yes, up to ${venue.maxGuests} guests`
        : 'Table bookings: not available online',
      venue.url,
    ]
      .filter(Boolean)
      .join('\n'),
  tables: (data) => {
    const REASONS = {
      disabled: 'This venue does not take online table bookings.',
      closed: 'The venue is closed on this date.',
      no_slots: 'No free slots on this date.',
    };
    if (data.reason && data.reason !== 'ok') return REASONS[data.reason] ?? data.reason;
    const free = (data.slots ?? []).filter((slot) => slot.available);
    if (free.length === 0) return REASONS.no_slots;
    return `${data.date}, up to ${data.maxGuests} guests: ${free.map((slot) => slot.label).join(' ')}`;
  },
  tickets: (data) => {
    const entries = Object.entries(data.ticketTypes ?? {});
    if (entries.length === 0) return 'No capacity limit on this event.';
    return entries
      .map(([ticketTypeId, remaining]) => `${ticketTypeId}  ${remaining} left`)
      .join('\n');
  },
  events: (data) =>
    data.length === 0
      ? 'No upcoming events found.'
      : data
          .map(
            (event) =>
              `${event.id}  ${formatDate(event.startAt)}  ${event.title}` +
              `${event.venue || event.city ? `  (${join([event.venue, event.city])})` : ''}`,
          )
          .join('\n'),
  event: (event) =>
    [
      `${event.title}  [${event.id}]`,
      `When: ${formatDate(event.startAt)}`,
      event.location
        ? `Where: ${join([event.location.name, event.location.address, event.location.city])}`
        : null,
      event.organizer ? `Organizer: ${event.organizer.name}` : null,
      ...(event.ticketTypes ?? []).map(
        (ticket) => `  ${ticket.id}  ${ticket.name}: ${price(ticket)}, ${ticket.status}`,
      ),
      event.refundPolicy?.refundsEnabled
        ? `Refunds: up to ${event.refundPolicy.refundDeadlineHours} h before start`
        : 'Refunds: disabled by the organizer',
      event.url,
    ]
      .filter(Boolean)
      .join('\n'),
};

/** Turns `{ error: { code, message, hint } }` into one readable line. */
const describeError = (status, body) => {
  const error = body && typeof body === 'object' ? body.error : null;
  if (!error) return `HTTP ${status}`;
  return `${error.code ?? `HTTP ${status}`}: ${error.message}${error.hint ? `\nHint: ${error.hint}` : ''}`;
};

const requirePositional = (positionals, index, name) => {
  const value = positionals[index];
  if (!value) throw new UsageError(`Missing <${name}>. Run "aoa --help".`);
  return encodeURIComponent(value);
};

/** Command → request. Each returns `{ method, path, query?, body?, format? }`. */
const COMMANDS = {
  venues: (positionals, values) => ({
    path: '/locations',
    query: {
      query: positionals[1],
      city: values.city,
      bookable: values.bookable ? 'true' : 'false',
      limit: values.limit,
      cursor: values.cursor,
    },
    format: FORMATTERS.venues,
  }),
  venue: (positionals) => ({
    path: `/locations/${requirePositional(positionals, 1, 'venueId')}`,
    format: FORMATTERS.venue,
  }),
  tables: (positionals, values) => {
    if (!values.date || !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
      throw new UsageError('tables needs --date YYYY-MM-DD.');
    }
    return {
      path: `/locations/${requirePositional(positionals, 1, 'venueId')}/availability`,
      query: { date: values.date },
      format: FORMATTERS.tables,
    };
  },
  events: (_positionals, values) => ({
    path: '/events',
    query: {
      city: values.city,
      category: values.category,
      limit: values.limit,
      cursor: values.cursor,
    },
    format: FORMATTERS.events,
  }),
  event: (positionals) => ({
    path: `/events/${requirePositional(positionals, 1, 'eventId')}`,
    format: FORMATTERS.event,
  }),
  tickets: (positionals) => ({
    path: `/events/${requirePositional(positionals, 1, 'eventId')}/availability`,
    format: FORMATTERS.tickets,
  }),
  order: (positionals) => ({
    path: `/orders/${requirePositional(positionals, 1, 'paymentId')}`,
  }),
  api: (positionals, values) => {
    const method = (positionals[1] ?? '').toUpperCase();
    const path = positionals[2];
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || !path?.startsWith('/')) {
      throw new UsageError('Usage: aoa api <GET|POST|PATCH|PUT|DELETE> </path> [--data <json>]');
    }
    let body;
    if (values.data !== undefined) {
      try {
        body = JSON.parse(values.data);
      } catch {
        throw new UsageError('--data must be valid JSON.');
      }
    }
    return { method, path, body };
  },
};

const COMMAND_OPTIONS = {
  city: { type: 'string' },
  category: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  bookable: { type: 'boolean', default: false },
  date: { type: 'string' },
  data: { type: 'string' },
  'idempotency-key': { type: 'string' },
};

const buildUrl = (baseUrl, path, query = {}) => {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
};

/**
 * Runs one CLI invocation.
 * @param {string[]} argv arguments after the executable
 * @param {{ fetch?: typeof fetch, env?: Record<string, string | undefined>,
 *   stdout?: (text: string) => void, stderr?: (text: string) => void }} io
 * @returns {Promise<number>} exit code
 */
export const run = async (argv, io = {}) => {
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...COMMAND_OPTIONS },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    stderr(`${error.message}\nRun "aoa --help".`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    stdout(CLI_VERSION);
    return EXIT_OK;
  }
  const command = positionals[0];
  if (values.help || !command) {
    stdout(HELP);
    return command || values.help ? EXIT_OK : EXIT_USAGE;
  }
  const buildRequest = COMMANDS[command];
  if (!buildRequest) {
    stderr(`Unknown command "${command}". Run "aoa --help".`);
    return EXIT_USAGE;
  }

  let request;
  try {
    request = buildRequest(positionals, values);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(error.message);
      return EXIT_USAGE;
    }
    throw error;
  }

  const baseUrl =
    values['base-url'] ?? (values.sandbox ? SANDBOX_BASE_URL : LIVE_BASE_URL);
  const apiKey = values['api-key'] ?? env.AOA_API_KEY;
  const method = request.method ?? 'GET';
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (request.body !== undefined) headers['Content-Type'] = 'application/json';
  // Bookings and checkout require an idempotency key. Pass your own tied to
  // the order to make a retry safe; otherwise each invocation gets a new one,
  // so a manual re-run is a new request rather than a silently deduped one.
  if (method === 'POST') {
    headers['Idempotency-Key'] = values['idempotency-key'] ?? randomUUID();
  }

  let response;
  try {
    response = await fetchImpl(buildUrl(baseUrl, request.path, request.query), {
      method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  } catch (error) {
    stderr(`Network error: ${error.message}`);
    return EXIT_API_ERROR;
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    stderr(describeError(response.status, body));
    if (values.json && body) stdout(JSON.stringify(body, null, 2));
    return EXIT_API_ERROR;
  }

  if (values.json || !request.format || !body || body.data === undefined) {
    stdout(body ? JSON.stringify(body, null, 2) : text);
  } else {
    stdout(request.format(body.data));
    if (body.meta?.hasMore) {
      stdout(`More results: repeat with --cursor ${body.meta.nextCursor}`);
    }
  }
  return EXIT_OK;
};
