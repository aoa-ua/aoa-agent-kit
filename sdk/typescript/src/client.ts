import { AoaApiError, errorFromResponse } from './errors.js';
import {
  OPERATIONS,
  type OperationId,
  type OperationMethods,
  type OperationSpec,
  type OperationTypes,
} from './generated/schema.js';
import type { AoaClientOptions, RequestOptions } from './options.js';
import { parseRateLimit, type RateLimitInfo } from './rateLimit.js';
import { SDK_VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://aoa.com.ua/api/v1';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** Thrown when a single attempt runs longer than `timeoutMs`. */
export class AoaTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`AOA request timed out after ${timeoutMs} ms`);
    this.name = 'AoaTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

type ListItem<Op extends OperationId> =
  OperationTypes[Op]['response'] extends { data: Array<infer Item> }
    ? Item
    : never;

/** GET operations whose `data` is an array: the ones `paginate` can walk. */
export type ListOperationId = {
  [Op in OperationId]: OperationTypes[Op]['response'] extends {
    data: Array<unknown>;
  }
    ? (typeof OPERATIONS)[Op]['method'] extends 'GET'
      ? Op
      : never
    : never;
}[OperationId];

export interface PaginateOptions extends RequestOptions {
  /** Stop after this many pages. */
  maxPages?: number;
}

export interface AoaClient extends OperationMethods {
  /** Calls any operation by its operationId. The typed methods use this. */
  request<Op extends OperationId>(
    operationId: Op,
    params?: OperationTypes[Op]['params'],
    options?: RequestOptions,
  ): Promise<OperationTypes[Op]['response']>;
  /**
   * Iterates over every item of a list operation, following
   * `meta.nextCursor` from page to page. Stops when a page has no cursor.
   */
  paginate<Op extends ListOperationId>(
    operationId: Op,
    params?: OperationTypes[Op]['params'] & { cursor?: string },
    options?: PaginateOptions,
  ): AsyncGenerator<ListItem<Op>, void, undefined>;
  /** Rate-limit state from the most recent response, or null before any. */
  readonly rateLimit: RateLimitInfo | null;
  readonly baseUrl: string;
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
}

const environmentApiKey = (): string | undefined => {
  const runtime = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.AOA_API_KEY || undefined;
};

const isBrowser = (): boolean => {
  const runtime = globalThis as { window?: unknown; document?: unknown };
  return runtime.window !== undefined && runtime.document !== undefined;
};

const newIdempotencyKey = (): string => {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.randomUUID) {
    throw new Error(
      '[aoa] crypto.randomUUID is unavailable: pass options.idempotencyKey explicitly.',
    );
  }
  return webCrypto.randomUUID();
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The operation was aborted', 'AbortError');

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const parseBody = (text: string): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const retryDelayMs = (rateLimit: RateLimitInfo | null): number => {
  const seconds = rateLimit?.retryAfterSeconds ?? rateLimit?.resetSeconds ?? 1;
  return Math.max(0, seconds) * 1000;
};

/**
 * Splits flat params into path, query and body.
 *
 * Declared path and query params go where the spec says. What is left goes
 * into the JSON body for operations that have one, and into the query string
 * for those that do not: a newer server parameter (such as `cursor`) then
 * works before the spec snapshot catches up.
 */
const buildRequest = (
  operationId: string,
  spec: OperationSpec,
  params: Record<string, unknown> = {},
): { path: string; body: unknown } => {
  const rest: Record<string, unknown> = { ...params };
  let path = spec.path;

  for (const name of spec.pathParams) {
    const value = rest[name];
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`[aoa] ${operationId}: "${name}" is required`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
    delete rest[name];
  }

  const query = new URLSearchParams();
  const appendQuery = (name: string, value: unknown) => {
    if (value === undefined || value === null) return;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) query.append(name, String(item));
  };
  for (const name of spec.queryParams) {
    appendQuery(name, rest[name]);
    delete rest[name];
  }

  let body: unknown;
  if (spec.body === 'flat') {
    body = rest;
  } else {
    if (spec.body === 'wrapped') {
      body = rest.body;
      delete rest.body;
    }
    for (const [name, value] of Object.entries(rest)) appendQuery(name, value);
  }

  const search = query.toString();
  return { path: search ? `${path}?${search}` : path, body };
};

/**
 * Creates an AOA API client with one typed method per operationId.
 *
 * ```ts
 * const aoa = createAoaClient({ apiKey: process.env.AOA_API_KEY });
 * const { data: events } = await aoa.searchEvents({ city: 'Київ', limit: 10 });
 * ```
 */
export const createAoaClient = (options: AoaClientOptions = {}): AoaClient => {
  const apiKey = options.apiKey ?? environmentApiKey();
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientMaxRetries = options.maxRetries ?? 0;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  // Browsers forbid or ignore a custom User-Agent; send it from servers only.
  const userAgent = isBrowser()
    ? undefined
    : [`aoa-sdk-typescript/${SDK_VERSION}`, options.userAgent]
        .filter(Boolean)
        .join(' ');

  if (typeof fetchImpl !== 'function') {
    throw new Error(
      '[aoa] No fetch implementation: use Node.js 20+ or pass options.fetch.',
    );
  }

  let lastRateLimit: RateLimitInfo | null = null;

  const sendOnce = async (
    url: string,
    init: RequestInit,
    attemptTimeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RawResponse> => {
    if (signal?.aborted) throw abortReason(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortReason(signal as AbortSignal));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutError = new AoaTimeoutError(attemptTimeoutMs);
    const timer = setTimeout(
      () => controller.abort(timeoutError),
      attemptTimeoutMs,
    );
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      // Read the body inside the timeout: a stalled body is a timeout too.
      const text = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        text,
      };
    } catch (error) {
      if (controller.signal.reason === timeoutError) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const request = async (
    operationId: string,
    params?: Record<string, unknown>,
    requestOptions: RequestOptions = {},
  ): Promise<unknown> => {
    const spec = (OPERATIONS as Record<string, OperationSpec>)[operationId];
    if (!spec) throw new TypeError(`[aoa] Unknown operation: ${operationId}`);
    if (spec.requiresAuth && !apiKey) {
      throw new Error(
        `[aoa] ${operationId} needs a partner API key: pass { apiKey } to createAoaClient() or set AOA_API_KEY.`,
      );
    }

    const { path, body } = buildRequest(operationId, spec, params);
    const headers = new Headers({ Accept: 'application/json' });
    if (userAgent) headers.set('User-Agent', userAgent);
    if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    if (options.agentProvider) {
      headers.set('X-Agent-Provider', options.agentProvider);
    }
    const idempotencyKey =
      requestOptions.idempotencyKey ??
      (spec.idempotencyKey === 'required' ? newIdempotencyKey() : undefined);
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
    let payload: string | undefined;
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }
    for (const [name, value] of Object.entries(requestOptions.headers ?? {})) {
      headers.set(name, value);
    }

    const url = `${baseUrl}${path}`;
    const maxRetries = requestOptions.maxRetries ?? clientMaxRetries;
    const attemptTimeoutMs = requestOptions.timeoutMs ?? timeoutMs;

    for (let attempt = 0; ; attempt += 1) {
      const raw = await sendOnce(
        url,
        { method: spec.method, headers, body: payload },
        attemptTimeoutMs,
        requestOptions.signal,
      );
      const rateLimit = parseRateLimit(raw.headers);
      if (rateLimit) lastRateLimit = rateLimit;
      const parsed = parseBody(raw.text);

      if (raw.status >= 200 && raw.status < 300) {
        if (typeof parsed === 'string') {
          throw new AoaApiError({
            status: raw.status,
            code: 'invalid_response',
            message: 'Expected a JSON response from the AOA API',
            rateLimit,
            body: parsed,
          });
        }
        return parsed;
      }

      if (raw.status === 429 && attempt < maxRetries) {
        const delay = retryDelayMs(rateLimit);
        if (delay <= maxRetryDelayMs) {
          await sleep(delay, requestOptions.signal);
          continue;
        }
      }
      throw errorFromResponse(raw.status, raw.statusText, parsed, rateLimit);
    }
  };

  async function* paginate(
    operationId: string,
    params: Record<string, unknown> = {},
    paginateOptions: PaginateOptions = {},
  ): AsyncGenerator<unknown, void, undefined> {
    const { maxPages = Number.POSITIVE_INFINITY, ...requestOptions } =
      paginateOptions;
    let cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const response = (await request(
        operationId,
        cursor ? { ...params, cursor } : params,
        requestOptions,
      )) as { data?: unknown; meta?: { nextCursor?: unknown } } | undefined;
      if (Array.isArray(response?.data)) yield* response.data;
      const next = response?.meta?.nextCursor;
      if (typeof next !== 'string' || next === '' || next === cursor) return;
      cursor = next;
    }
  }

  const client: Record<string, unknown> = {
    request,
    paginate,
    baseUrl,
  };
  Object.defineProperty(client, 'rateLimit', {
    enumerable: true,
    get: () => lastRateLimit,
  });
  for (const operationId of Object.keys(OPERATIONS)) {
    client[operationId] = (
      params?: Record<string, unknown>,
      requestOptions?: RequestOptions,
    ) => request(operationId, params, requestOptions);
  }
  return client as unknown as AoaClient;
};
