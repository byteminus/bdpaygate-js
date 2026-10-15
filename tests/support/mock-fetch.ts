import type { FetchLike, JsonObject } from '../../src/index.js';

export interface MockRequest {
  url: URL;
  method: string;
  headers: Headers;
  text: string;
  /** The JSON body, the form body, or the query string: whichever the request carried. */
  data: JsonObject;
}

export type Handler = (request: MockRequest) => Response | Promise<Response>;

/** Pattern (host + path, `*` wildcard, matched against the start) -> handler. First match wins. */
export type Routes = Record<string, Handler>;

export function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers },
  });
}

/** What fetch throws when AbortSignal.timeout fires. */
export function timeout(): never {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

  return new RegExp(`^${escaped}`);
}

function parse(text: string, contentType: string, url: URL): JsonObject {
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as JsonObject;
    } catch {
      return {};
    }
  }

  if (text !== '') {
    return Object.fromEntries(new URLSearchParams(text));
  }

  return Object.fromEntries(url.searchParams);
}

export interface MockFetch {
  fetch: FetchLike;
  requests: MockRequest[];
  unmatched: string[];
}

export function mockFetch(routes: () => Routes): MockFetch {
  const requests: MockRequest[] = [];
  const unmatched: string[] = [];

  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const text = typeof init.body === 'string' ? init.body : '';
    const request: MockRequest = {
      url,
      method: init.method ?? 'GET',
      headers,
      text,
      data: parse(text, headers.get('content-type') ?? '', url),
    };
    requests.push(request);

    const target = url.host + url.pathname;

    for (const [pattern, handler] of Object.entries(routes())) {
      if (toRegExp(pattern).test(target)) {
        return handler(request);
      }
    }

    unmatched.push(`${request.method} ${url.href}`);

    return reply({ error: `No stub for ${url.href}` }, 599);
  };

  return { fetch, requests, unmatched };
}
