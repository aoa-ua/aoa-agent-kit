# Changelog

All notable changes to this kit. The SDKs follow [Semantic Versioning](https://semver.org);
the API itself is versioned in its path (`/api/v1`).

## Unreleased

- Agent Skill `aoa-webhooks`: receiving AOA webhooks end to end. Endpoint
  management, event catalog and payloads, `AOA-Signature` verification with
  each SDK and without one, retries and deduplication, auto-disable and
  recovery, replacing a leaked secret, Make, Zapier and n8n.

## 0.1.0 (unreleased)

First public version.

- TypeScript SDK `@aoa-ua/sdk`: typed client for every operation of AOA
  API v1 (16 at release, including `batchOperations`), types generated from
  the OpenAPI spec
  (`scripts/generate-types.mjs`), automatic `Idempotency-Key` for table
  bookings and checkout, opt-in `429` retries honouring `Retry-After`,
  rate-limit state, cursor pagination helper, `Prefer: respond-async` on
  checkout, webhook signature verification on WebCrypto. Zero runtime
  dependencies.
- Python SDK `aoa-sdk`: the same operations on the standard library
  (`urllib`), pluggable transport, `TypedDict` models, webhook verification.
- Go SDK `github.com/aoa-ua/aoa-agent-kit/sdk/go`: the same operations on
  `net/http`, generic `Response[T]`, redirect-safe default client, webhook
  verification.
- Agent Skills: `aoa`, `aoa-venues-and-tables`, `aoa-events-and-tickets`,
  `aoa-api-integration`.
- Agent Plugins 1.0.0 manifest (`plugin.json`) and MCP configuration
  (`mcp.json`) for the AOA MCP server.
- `AGENTS.md`, `.cursorrules`, CI for all three SDKs.
