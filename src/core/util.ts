import type { JsonObject } from './types.js';

/** The first non-empty scalar among the given keys, as a string. */
export function field(data: JsonObject | null | undefined, ...keys: string[]): string | null {
  if (!data) {
    return null;
  }

  for (const key of keys) {
    const value = data[key];

    if (
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
      String(value) !== ''
    ) {
      return String(value);
    }
  }

  return null;
}

/**
 * A response value as a string, the way PHP's (string) cast reads gateway
 * JSON: null and false are "", true is "1", numbers print plainly, and
 * arrays or objects are "" (never "[object Object]").
 */
export function str(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return value === true ? '1' : '';
}

/** A scalar as a string (true is "1", false is ""); null for arrays, objects and nullish. */
export function scalar(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? '1' : '';
  }

  return null;
}

/** The `exp` claim of a JWT, in seconds since the epoch, or null. The signature is not checked. */
export function jwtExpiry(token: string): number | null {
  const segment = `${token}..`.split('.')[1] ?? '';

  try {
    const binary = atob(segment.replaceAll('-', '+').replaceAll('_', '/'));
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    );
    const exp = isObject(claims) ? claims.exp : null;
    const number =
      typeof exp === 'number' ? exp : typeof exp === 'string' && exp.trim() !== '' ? Number(exp) : Number.NaN;

    return Number.isFinite(number) ? Math.trunc(number) : null;
  } catch {
    return null;
  }
}

/** A nested object, or an empty one. */
export function object(data: JsonObject | null | undefined, key: string): JsonObject {
  const value = data?.[key];

  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** A nested list, or an empty one. */
export function list(data: JsonObject | null | undefined, key: string): unknown[] {
  const value = data?.[key];

  if (Array.isArray(value)) {
    return value;
  }

  return value !== null && typeof value === 'object' ? Object.values(value) : [];
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }

  return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Trim to a maximum length, counting characters rather than UTF-16 units. */
export function limit(value: string, max: number): string {
  return [...value].slice(0, max).join('');
}

/**
 * node:crypto, loaded only when a driver that needs it is used, so the
 * gateways that need nothing but fetch run on any edge runtime.
 */
export function nodeCrypto(): Promise<typeof import('node:crypto')> {
  return import('node:crypto');
}
