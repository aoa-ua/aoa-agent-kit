import type { WebhookEventType } from './generated/schema.js';

/** Header with the signature: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const WEBHOOK_SIGNATURE_HEADER = 'AOA-Signature';
/** Same value on every retry of one delivery: deduplicate by it. */
export const WEBHOOK_DELIVERY_ID_HEADER = 'AOA-Delivery-Id';
export const WEBHOOK_EVENT_TYPE_HEADER = 'AOA-Event-Type';
/** Default replay window, as recommended by the AOA docs. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Delivery body. `id` equals `AOA-Delivery-Id`. The shape of `data` depends
 * on `type`; see https://aoa.com.ua/docs/webhooks/events.
 */
export interface WebhookEvent<Data = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  /** ISO 8601, UTC. */
  createdAt: string;
  data: Data;
}

export interface VerifyWebhookOptions {
  /** Reject signatures older (or newer) than this. @default 300 */
  toleranceSeconds?: number;
  /** Current time, for tests. @default Date.now() */
  now?: Date | number;
}

/** Signature header is missing, malformed, stale or does not match. */
export class AoaWebhookSignatureError extends Error {
  constructor(message = 'Invalid AOA-Signature') {
    super(message);
    this.name = 'AoaWebhookSignatureError';
  }
}

const encoder = new TextEncoder();

// Copies into a fresh ArrayBuffer: WebCrypto rejects views over a
// SharedArrayBuffer, and the caller's buffer is left untouched.
const toBytes = (value: string | Uint8Array): Uint8Array<ArrayBuffer> =>
  typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> | null => {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const parseHeader = (header: string) => {
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  return { timestamp, signatures };
};

/**
 * Verifies `AOA-Signature` against the RAW request body.
 *
 * Pass the body exactly as received (string or bytes): re-serialized JSON
 * changes key order or whitespace and never matches. The comparison runs
 * inside WebCrypto `subtle.verify`, which is constant-time, so this works in
 * Node.js 20+, Deno, Bun and edge runtimes.
 */
export const verifyWebhookSignature = async (
  header: string | null | undefined,
  rawBody: string | Uint8Array,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<boolean> => {
  if (!header || !secret) return false;
  const { timestamp, signatures } = parseHeader(header);
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length) {
    return false;
  }

  const tolerance =
    options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : (options.now ?? Date.now());
  const age = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (age > tolerance) return false;

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('[aoa] WebCrypto (crypto.subtle) is required');

  const key = await subtle.importKey(
    'raw',
    toBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const prefix = encoder.encode(`${timestamp}.`);
  const body = toBytes(rawBody);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);

  for (const signature of signatures) {
    const bytes = hexToBytes(signature);
    if (bytes && (await subtle.verify('HMAC', key, bytes, signed))) {
      return true;
    }
  }
  return false;
};

/**
 * Verifies the signature and parses the delivery. Throws
 * `AoaWebhookSignatureError` when the signature does not check out.
 */
export const constructWebhookEvent = async <Data = Record<string, unknown>>(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent<Data>> => {
  if (!(await verifyWebhookSignature(header, rawBody, secret, options))) {
    throw new AoaWebhookSignatureError();
  }
  const text =
    typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  return JSON.parse(text) as WebhookEvent<Data>;
};
