import { MalformedCallbackError } from './errors.js';
import type { JsonObject } from './types.js';

/** A gateway's request to a callback URL, already parsed by an adapter. */
export interface CallbackInput {
  method: string;
  /** The query string. */
  query: JsonObject;
  /** The form or JSON body. Empty for GET. */
  body: JsonObject;
  headers?: Record<string, string>;
  /** The unparsed body, for gateways that sign it. */
  rawBody?: string;
  /** The client's address as the framework sees it (honouring its trusted-proxy setting). */
  clientIp?: string;
}

/**
 * Read-only view of a callback. Nothing in it is trusted: drivers use it only
 * to find the payment and then ask the gateway's API what happened.
 */
export class CallbackRequest {
  readonly method: string;
  readonly query: JsonObject;
  readonly body: JsonObject;
  readonly headers: Record<string, string>;
  readonly rawBody: string | undefined;
  private readonly clientIp: string | undefined;

  constructor(input: CallbackInput) {
    this.method = input.method.toUpperCase();
    this.query = input.query;
    this.body = input.body;
    this.rawBody = input.rawBody;
    this.clientIp = input.clientIp;
    this.headers = Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
  }

  /** Query and body merged; the body wins. */
  all(): JsonObject {
    return { ...this.query, ...this.body };
  }

  has(key: string): boolean {
    return this.all()[key] !== undefined;
  }

  /**
   * A parameter as a string. Missing gives the fallback; an array or object
   * (e.g. ?invoice_id[]=x) is malformed and throws.
   */
  string(key: string, fallback = ''): string {
    return CallbackRequest.scalar(this.all()[key], key, fallback);
  }

  /** A query-string parameter only, ignoring the body. Same rules as string(). */
  queryString(key: string, fallback = ''): string {
    return CallbackRequest.scalar(this.query[key], key, fallback);
  }

  /** A body parameter only, ignoring the query string. Same rules as string(). */
  bodyString(key: string, fallback = ''): string {
    return CallbackRequest.scalar(this.body[key], key, fallback);
  }

  private static scalar(value: unknown, key: string, fallback: string): string {
    if (value === undefined || value === null) {
      return fallback;
    }

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    throw new MalformedCallbackError(`Callback parameter [${key}] must be a single value.`);
  }

  /** The first non-empty of several parameter names. */
  first(...keys: string[]): string {
    for (const key of keys) {
      const value = this.string(key);

      if (value !== '') {
        return value;
      }
    }

    return '';
  }

  /**
   * The caller's IP: what the framework reported, else the usual proxy
   * headers. Headers can be forged, so use it for logging and for gateways
   * that want it passed along, never to decide anything.
   */
  get ip(): string | null {
    const forwarded = this.header('x-forwarded-for')?.split(',')[0];
    const ip = this.clientIp ?? this.header('cf-connecting-ip') ?? this.header('x-real-ip') ?? forwarded;

    return ip ? ip.trim().replace(/^::ffff:/, '') : null;
  }

  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
}
