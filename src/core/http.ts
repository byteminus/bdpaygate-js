import { GatewayUnavailableError } from './errors.js';
import type { JsonObject } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  /** Sent as a JSON body. */
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string | number | boolean | null | undefined>;
  /** Appended to the URL. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** A raw body, sent as is. */
  body?: string;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /**
   * The body as an object, whatever the gateway sent. Many Bangladeshi
   * gateways answer errors with HTTP 200 and a body that is not JSON at all:
   * those come back as { http_status, body }. A JSON array is spread into an
   * object with numeric keys.
   */
  data: JsonObject;
  text: string;
}

function encode(values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  }

  return params.toString();
}

export function decode(status: number, text: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(text);

    if (Array.isArray(parsed)) {
      return { ...parsed };
    }

    if (parsed !== null && typeof parsed === 'object') {
      return parsed as JsonObject;
    }
  } catch {
    // Not JSON.
  }

  return { http_status: status, body: text.slice(0, 2000) };
}

/**
 * Send one request. No automatic retries: a gateway POST that times out may
 * still have gone through, and each driver knows how to query instead of
 * re-sending. A timeout or dropped connection becomes GatewayUnavailableError.
 */
export async function send(
  fetcher: FetchLike,
  url: string,
  request: HttpRequest,
  options: { timeoutMs: number; gateway: string },
): Promise<HttpResponse> {
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
  let body: string | undefined = request.body;

  if (request.json !== undefined) {
    body = JSON.stringify(request.json);
    headers['content-type'] ??= 'application/json';
  } else if (request.form !== undefined) {
    body = encode(request.form);
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
  }

  const target = request.query ? `${url}${url.includes('?') ? '&' : '?'}${encode(request.query)}` : url;

  let response: Response;
  let text: string;

  try {
    response = await fetcher(target, {
      method: request.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'follow',
    });
    text = await response.text();
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.cause instanceof Error
          ? error.cause.message
          : error.message
        : String(error);

    throw new GatewayUnavailableError(`${options.gateway} did not respond: ${reason}`, options.gateway);
  }

  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    data: decode(response.status, text),
    text,
  };
}
