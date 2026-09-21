/**
 * Rate-limit state parsed from response headers.
 *
 * AOA sends two equivalent sets: the IETF draft pair `RateLimit-Policy`
 * (`"default";q=60;w=60`) and `RateLimit` (`"default";r=59;t=60`), plus the
 * historical `X-RateLimit-Limit` / `X-RateLimit-Remaining`. `Retry-After`
 * comes with 429 (and as a polling interval with a 202).
 */
export interface RateLimitInfo {
  /** Requests allowed per window (`q` or `X-RateLimit-Limit`). */
  limit?: number;
  /** Requests left in the current window (`r` or `X-RateLimit-Remaining`). */
  remaining?: number;
  /** Upper bound, in seconds, until the quota refills (`t`). */
  resetSeconds?: number;
  /** Window length in seconds (`w`). */
  windowSeconds?: number;
  /**
   * `Retry-After` in seconds: the wait before retrying a 429, or the polling
   * interval of a 202 from an asynchronous checkout.
   */
  retryAfterSeconds?: number;
}

type HeaderSource = Pick<Headers, 'get'>;

const toNumber = (value: string | undefined | null): number | undefined => {
  if (value === undefined || value === null || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Parameters of a structured-field item: `"default";q=60;w=60` → {q, w}. */
const structuredParams = (value: string | null): Record<string, string> => {
  const params: Record<string, string> = {};
  if (!value) return params;
  for (const part of value.split(';').slice(1)) {
    const [key, raw] = part.split('=');
    if (key && raw !== undefined) params[key.trim()] = raw.trim();
  }
  return params;
};

/** `Retry-After` is either delta-seconds or an HTTP date. */
const parseRetryAfter = (
  value: string | null,
  now: number,
): number | undefined => {
  if (!value) return undefined;
  const seconds = toNumber(value);
  if (seconds !== undefined) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
};

/** Returns `null` when the response carries no rate-limit headers at all. */
export const parseRateLimit = (
  headers: HeaderSource,
  now: number = Date.now(),
): RateLimitInfo | null => {
  const policy = structuredParams(headers.get('ratelimit-policy'));
  const state = structuredParams(headers.get('ratelimit'));

  const info: RateLimitInfo = {
    limit: toNumber(policy.q) ?? toNumber(headers.get('x-ratelimit-limit')),
    remaining:
      toNumber(state.r) ?? toNumber(headers.get('x-ratelimit-remaining')),
    resetSeconds: toNumber(state.t),
    windowSeconds: toNumber(policy.w),
    retryAfterSeconds: parseRetryAfter(headers.get('retry-after'), now),
  };

  const present = Object.values(info).some((value) => value !== undefined);
  if (!present) return null;
  for (const key of Object.keys(info) as (keyof RateLimitInfo)[]) {
    if (info[key] === undefined) delete info[key];
  }
  return info;
};
