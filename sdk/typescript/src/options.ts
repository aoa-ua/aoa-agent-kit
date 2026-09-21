/** Options for `createAoaClient`. Every field is optional. */
export interface AoaClientOptions {
  /**
   * Partner API key (`aoa_live_...`). Required for write operations; on reads
   * it raises the limit from 60 to 600 requests per minute. Defaults to the
   * `AOA_API_KEY` environment variable when it exists. Keep it server-side.
   */
  apiKey?: string;
  /** @default "https://aoa.com.ua/api/v1" */
  baseUrl?: string;
  /** Custom fetch (tests, proxies, instrumentation). Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Per-attempt timeout. Checkout creates a bank invoice synchronously, so
   * keep it at 15 seconds or more.
   * @default 30000
   */
  timeoutMs?: number;
  /**
   * How many times to retry a request answered with 429, waiting for
   * `Retry-After` each time. Opt-in: 0 means never retry.
   * @default 0
   */
  maxRetries?: number;
  /**
   * Do not wait longer than this for one retry; a longer `Retry-After`
   * surfaces as an `AoaApiError` instead.
   * @default 60000
   */
  maxRetryDelayMs?: number;
  /**
   * Analytics identifier of your connector, sent as `X-Agent-Provider`.
   * Never used for authorization.
   */
  agentProvider?: string;
  /** Extra token appended to the SDK user agent (server runtimes only). */
  userAgent?: string;
  /** Headers added to every request. */
  headers?: Record<string, string>;
}

/** Options for a single call. */
export interface RequestOptions {
  /**
   * Sent as `Idempotency-Key`. For operations that require one
   * (`createTableReservation`, `createTicketCheckout`) the SDK generates a
   * UUID when omitted and reuses it across its own retries. Pass a value tied
   * to your order or cart id so a retry after a crash cannot double-book.
   */
  idempotencyKey?: string;
  /** Abort the request (and any pending retry wait). */
  signal?: AbortSignal;
  /** Overrides the client timeout for this call. */
  timeoutMs?: number;
  /** Overrides the client retry count for this call. */
  maxRetries?: number;
  /** Extra headers for this call only. */
  headers?: Record<string, string>;
}
