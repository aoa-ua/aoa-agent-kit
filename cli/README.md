# @aoa-ua/cli

Official command-line client for the [AOA](https://aoa.com.ua) public API.
Search venues and events in Ukraine, check free table slots and ticket stock,
read order status, or call any operation from the
[OpenAPI spec](https://aoa.com.ua/openapi.json). Zero dependencies, Node 20+.

```bash
npx @aoa-ua/cli venues --city Київ --bookable
npx @aoa-ua/cli tables <venueId> --date 2026-11-14
npx @aoa-ua/cli events --city Київ --category live_music
npx @aoa-ua/cli event <eventId>
```

Or install it once: `npm install -g @aoa-ua/cli`, then run `aoa --help`.

## Commands

| Command | What it does |
|---|---|
| `aoa venues [query]` | Search venues. `--city`, `--bookable`, `--limit`, `--cursor` |
| `aoa venue <venueId>` | Address, opening hours, phone, whether it takes table bookings |
| `aoa tables <venueId> --date YYYY-MM-DD` | Free table slots for a date |
| `aoa events` | Upcoming events. `--city`, `--category`, `--limit`, `--cursor` |
| `aoa event <eventId>` | Event details, ticket types with prices, refund policy |
| `aoa tickets <eventId>` | Live remaining tickets per ticket type |
| `aoa order <paymentId>` | Order (payment) status, partner key required |
| `aoa api <METHOD> </path>` | Any API operation. `--data <json>`, `--idempotency-key <key>` |

Every command accepts `--json` to print the raw API response, which is what
scripts and coding agents should read.

## Keys and environments

- **Reads need no key**: 60 requests per minute per IP.
- **Writes** (table bookings, ticket holds, checkout, webhooks) need a partner
  key: `export AOA_API_KEY=aoa_live_...` or `--api-key`. Keep it out of
  shell history, commits and logs.
- **Sandbox**: `--sandbox` points at `https://aoa.com.ua/api/sandbox/v1`,
  the same operations on test data with no real bookings or payments. Writes
  there take any self-made `aoa_test_<16+ characters>` key, no sign-up.

```bash
export AOA_API_KEY=aoa_test_$(openssl rand -hex 8)
aoa --sandbox api POST /reservations \
  --data '{"eventId":"sbx-concert","tickets":[{"ticketTypeId":"sbx-concert-standard","quantity":1}]}'
```

A booking or a purchase is made for a person: run a write only after they
confirmed the venue or event, date, time, party size or tickets, and price.

## Exit codes

`0` success, `1` API or network error (the error code, message and hint go to
stderr), `2` wrong usage.

## Links

- API docs: https://aoa.com.ua/docs/api-reference/introduction
- Versioning and deprecation policy: https://aoa.com.ua/docs/api-reference/versioning
- TypeScript SDK: [`@aoa-ua/sdk`](https://www.npmjs.com/package/@aoa-ua/sdk)
- MCP server for assistants: `https://aoa.com.ua/api/mcp`
