import type { RateLimitInfo } from './rateLimit.js';

/**
 * Stable error codes returned by the AOA API. Branch on `code`, never on
 * `message`: messages are for people and some of them are in Ukrainian.
 */
export type AoaErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'gone'
  | 'conflict'
  | 'rate_limited'
  | 'internal_error'
  | (string & {});

export interface AoaApiErrorInit {
  status: number;
  code: AoaErrorCode;
  message: string;
  hint?: string;
  rateLimit?: RateLimitInfo | null;
  body?: unknown;
}

/** Codes worth retrying as-is (`rate_limited` after `Retry-After`). */
const RETRYABLE = new Set<string>(['rate_limited', 'internal_error']);

/**
 * Error response from the AOA API: `{ "error": { code, message, hint? } }`.
 *
 * For a response that is not in this envelope (for example an HTML page
 * from a proxy) `code` is `http_<status>`.
 */
export class AoaApiError extends Error {
  /** HTTP status. */
  readonly status: number;
  /** Stable machine-readable code. */
  readonly code: AoaErrorCode;
  /** What to do next to fix the request, when the API knows. */
  readonly hint?: string;
  /** Rate-limit headers of the failed response. */
  readonly rateLimit: RateLimitInfo | null;
  /** Parsed body (or raw text) of the failed response. */
  readonly body: unknown;

  constructor(init: AoaApiErrorInit) {
    super(init.message);
    this.name = 'AoaApiError';
    this.status = init.status;
    this.code = init.code;
    this.hint = init.hint;
    this.rateLimit = init.rateLimit ?? null;
    this.body = init.body;
  }

  /**
   * True for errors a later identical request may fix: `rate_limited`
   * (wait `Retry-After`) and `internal_error` (back off, up to 3 attempts).
   * Retry writes only with the same `Idempotency-Key`.
   */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Builds an `AoaApiError` from a non-2xx response body. */
export const errorFromResponse = (
  status: number,
  statusText: string,
  body: unknown,
  rateLimit: RateLimitInfo | null,
): AoaApiError => {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (envelope && typeof envelope.code === 'string') {
    return new AoaApiError({
      status,
      code: envelope.code,
      message:
        typeof envelope.message === 'string' ? envelope.message : statusText,
      hint: typeof envelope.hint === 'string' ? envelope.hint : undefined,
      rateLimit,
      body,
    });
  }
  return new AoaApiError({
    status,
    code: `http_${status}`,
    message: statusText || `HTTP ${status}`,
    rateLimit,
    body,
  });
};
