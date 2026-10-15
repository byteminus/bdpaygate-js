import { GatewayError } from '../core/errors.js';
import type { JsonObject } from '../core/types.js';
import { isObject, nodeCrypto } from '../core/util.js';

/**
 * DGePay's request envelope, as its published SDK builds it.
 *
 * - Body: the JSON payload (keys sorted), AES-128-ECB with PKCS#7 padding,
 *   base64. The key is the client secret padded with "0" (or cut) to 16 bytes.
 * - Signature header: base64(HMAC-SHA256(api key, canonical)), where
 *   canonical is that same sorted JSON with { } " : , and spaces removed,
 *   i.e. key1value1key2value2..., nested objects inline, nulls as "null"
 *   and numbers as JSON prints them (150.0, 150.5).
 *
 * JavaScript has a single number type, so every number is printed the way
 * the SDK prints a float: 150 becomes 150.0, 150.5 stays 150.5.
 *
 * ECB is DGePay's choice, not ours; it is only used because the API requires it.
 */
export class DgePayCrypto {
  constructor(
    private readonly clientSecret: string,
    private readonly apiKey: string,
    private readonly gateway = 'dgepay',
  ) {}

  /** The payload as DGePay's SDK serialises it: keys sorted, slashes and Unicode unescaped. */
  json(payload: JsonObject): string {
    return this.encode(payload);
  }

  /** The string the Signature header is computed over. */
  canonical(payload: JsonObject): string {
    return this.json(payload).replace(/[{}":, ]/g, '');
  }

  async sign(payload: JsonObject): Promise<string> {
    const { createHmac } = await nodeCrypto();

    return createHmac('sha256', this.apiKey).update(this.canonical(payload), 'utf8').digest('base64');
  }

  async encrypt(payload: JsonObject): Promise<string> {
    const json = this.json(payload);
    const { createCipheriv } = await nodeCrypto();

    try {
      const cipher = createCipheriv('aes-128-ecb', this.key(), null);

      return cipher.update(json, 'utf8', 'base64') + cipher.final('base64');
    } catch {
      throw new GatewayError('Could not encrypt the DGePay payload.', this.gateway);
    }
  }

  /**
   * Decrypt a base64 blob (e.g. the "data" DGePay appends to the redirect URL)
   * into an object. Null when it does not decrypt to JSON.
   *
   * Query-string parsing turns "+" into spaces; they are restored here.
   */
  async decrypt(encoded: string): Promise<JsonObject | null> {
    let value = encoded.trim().replaceAll(' ', '+');

    if (value.includes('%')) {
      value = rawUrlDecode(value);
    }

    value = value.replaceAll('-', '+').replaceAll('_', '/');
    value = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/[\t\n\r]/g, '');

    // Strict base64: anything outside the alphabet (or a truncated group) is not DGePay's.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1) {
      return null;
    }

    const { createDecipheriv } = await nodeCrypto();
    let plain: string;

    try {
      const decipher = createDecipheriv('aes-128-ecb', this.key(), null);
      const head = decipher.update(value, 'base64');
      const tail = decipher.final();
      const bytes = new Uint8Array(head.length + tail.length);
      bytes.set(head, 0);
      bytes.set(tail, head.length);

      if (bytes.length === 0) {
        return null;
      }

      plain = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }

    try {
      const data: unknown = JSON.parse(plain);

      if (Array.isArray(data)) {
        return { ...data };
      }

      return isObject(data) ? data : null;
    } catch {
      return null;
    }
  }

  /** The client secret's bytes, padded with "0" (or cut) to 16. */
  private key(): Uint8Array {
    const secret = new TextEncoder().encode(this.clientSecret);
    const key = new Uint8Array(16).fill(0x30);
    key.set(secret.subarray(0, 16));

    return key;
  }

  /** JSON with keys sorted (recursively), unescaped slashes and Unicode, and floats keeping ".0". */
  private encode(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null';
    }

    if (typeof value === 'string') {
      // PHP escapes the two JavaScript line terminators even with unescaped Unicode.
      return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new GatewayError('Could not encode the DGePay payload as JSON.', this.gateway);
      }

      return float(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => this.encode(item)).join(',')}]`;
    }

    if (isObject(value)) {
      const keys = Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort(compareBytes);

      return `{${keys.map((key) => `${JSON.stringify(key)}:${this.encode(value[key])}`).join(',')}}`;
    }

    throw new GatewayError('Could not encode the DGePay payload as JSON.', this.gateway);
  }
}

/** A number as PHP's json_encode prints a float with JSON_PRESERVE_ZERO_FRACTION. */
function float(value: number): string {
  const text = String(value);

  if (/e/i.test(text)) {
    // 1e+21 -> 1.0e+21, as PHP prints it.
    const [mantissa = '', exponent = ''] = text.split(/e/i);

    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${exponent}`;
  }

  return text.includes('.') ? text : `${text}.0`;
}

/** ksort(SORT_STRING): byte order of the UTF-8 keys. */
function compareBytes(a: string, b: string): number {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);

  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return left.length - right.length;
}

/** rawurldecode: %XX sequences only, leaving malformed ones as they are. */
function rawUrlDecode(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}
