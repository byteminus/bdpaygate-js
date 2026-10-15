import { ConfigurationError, GatewayError, GatewayUnavailableError } from './errors.js';
import type { BdPayGate, RedirectKey, RedirectTarget } from './manager.js';
import { type CallbackInput, CallbackRequest } from './request.js';
import { type JsonObject, OUTCOMES, type Outcome, type Payment, PaymentStatus } from './types.js';

/** A framework-neutral HTTP response. Adapters turn it into their own. */
export interface CallbackResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON text for IPN answers, null for redirects. */
  body: string | null;
}

function json(status: number, body: JsonObject): CallbackResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function redirect(location: string): CallbackResponse {
  return { status: 303, headers: { location, 'cache-control': 'no-store' }, body: null };
}

function destination(
  redirects: Partial<Record<RedirectKey, RedirectTarget>>,
  key: RedirectKey,
  payment: Payment | null,
): string {
  const target = redirects[key] ?? redirects.failed ?? '/';

  if (typeof target === 'function') {
    return target(payment);
  }

  if (!payment) {
    return target;
  }

  return `${target}${target.includes('?') ? '&' : '?'}payment=${encodeURIComponent(payment.id)}`;
}

function keyFor(status: PaymentStatus): RedirectKey {
  switch (status) {
    case PaymentStatus.Completed:
    case PaymentStatus.PartiallyRefunded:
    case PaymentStatus.Refunded:
      return 'success';
    case PaymentStatus.Cancelled:
      return 'cancelled';
    case PaymentStatus.Pending:
      return 'pending';
    default:
      return 'failed';
  }
}

/**
 * The only code a gateway ever talks to. It verifies, records, fires
 * events, then sends the customer on to your app.
 *
 * Mount it without sessions, CSRF or auth: several gateways return the
 * customer with a cross-site POST.
 */
export async function handleCallback(
  manager: BdPayGate,
  gatewayName: string,
  outcomeName: string,
  input: CallbackInput,
  redirects: Partial<Record<RedirectKey, RedirectTarget>>,
  logger: { warn(message: string, context?: JsonObject): void },
): Promise<CallbackResponse> {
  if (!manager.has(gatewayName) || !OUTCOMES.includes(outcomeName as Outcome)) {
    return json(404, { ok: false, reason: 'not found' });
  }

  const outcome = outcomeName as Outcome;
  const ipn = outcome === 'ipn';
  let gateway: ReturnType<BdPayGate['gateway']>;

  try {
    gateway = manager.gateway(gatewayName);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return json(404, { ok: false, reason: 'not found' });
    }

    throw error;
  }

  try {
    const result = await gateway.handleCallback(new CallbackRequest(input), outcome);

    return ipn
      ? json(200, { ok: true, status: result.status })
      : redirect(destination(redirects, keyFor(result.status), result.payment));
  } catch (error) {
    if (error instanceof GatewayUnavailableError) {
      // We could not confirm either way. The payment stays pending; the
      // gateway retries its IPN, and syncPending() settles the rest.
      logger.warn('BdPayGate could not reach the gateway to confirm a callback', {
        gateway: gatewayName,
        outcome,
        reason: error.message,
      });

      return ipn
        ? json(503, { ok: false, reason: 'gateway unavailable' })
        : redirect(destination(redirects, 'pending', null));
    }

    if (error instanceof GatewayError) {
      logger.warn('BdPayGate rejected a callback', {
        gateway: gatewayName,
        outcome,
        reason: error.message,
        payload: error.response,
      });

      return ipn
        ? json(400, { ok: false, reason: error.message })
        : redirect(destination(redirects, 'failed', null));
    }

    if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
      // Malformed input reaching a driver. Nothing was changed: state only
      // moves through the gateway's own answer.
      logger.warn('BdPayGate rejected a malformed callback', {
        gateway: gatewayName,
        outcome,
        reason: error.message,
      });

      return ipn
        ? json(400, { ok: false, reason: 'malformed callback' })
        : redirect(destination(redirects, 'failed', null));
    }

    throw error;
  }
}

// ---------------------------------------------------------------- parsing

/**
 * Parse URL-encoded pairs the way PHP and Express's extended parser do for
 * the simple cases: `a=1&a=2` and `a[]=1` become arrays.
 */
export function parseParams(params: URLSearchParams | Iterable<[string, string]>): JsonObject {
  const out: JsonObject = {};

  for (const [rawKey, value] of params) {
    const isList = rawKey.endsWith('[]');
    const key = isList ? rawKey.slice(0, -2) : rawKey;
    const existing = out[key];

    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing !== undefined) {
      out[key] = [existing, value];
    } else {
      out[key] = isList ? [value] : value;
    }
  }

  return out;
}

/** Parse a body by content type. Never throws: a broken body is an empty one. */
export function parseBody(contentType: string | null | undefined, raw: string): JsonObject {
  const type = (contentType ?? '').toLowerCase();

  if (raw === '') {
    return {};
  }

  if (type.includes('json')) {
    try {
      const parsed: unknown = JSON.parse(raw);

      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as JsonObject)
        : {};
    } catch {
      return {};
    }
  }

  if (type.includes('application/x-www-form-urlencoded') || type === '') {
    return parseParams(new URLSearchParams(raw));
  }

  return {};
}

/** Turn a Web Request into callback input. */
export async function inputFromRequest(request: Request): Promise<CallbackInput> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const contentType = request.headers.get('content-type');
  let body: JsonObject = {};
  let rawBody: string | undefined;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (contentType?.toLowerCase().includes('multipart/form-data')) {
      const form = await request.formData();
      const pairs: [string, string][] = [];
      form.forEach((value, key) => {
        if (typeof value === 'string') {
          pairs.push([key, value]);
        }
      });
      body = parseParams(pairs);
    } else {
      rawBody = await request.text();
      body = parseBody(contentType, rawBody);
    }
  }

  return { method: request.method, query: parseParams(url.searchParams), body, headers, rawBody };
}

export function toWebResponse(response: CallbackResponse): Response {
  return new Response(response.body, { status: response.status, headers: response.headers });
}

/** Find {gateway}/{outcome} after the prefix in a path. */
export function matchPath(prefix: string, pathname: string): { gateway: string; outcome: string } | null {
  const index = pathname.indexOf(`${prefix}/`);

  if (index === -1) {
    return null;
  }

  const [gateway, outcome, ...rest] = pathname.slice(index + prefix.length + 1).split('/');

  if (!gateway || !outcome || rest.some((part) => part !== '')) {
    return null;
  }

  return { gateway: decodeURIComponent(gateway), outcome: decodeURIComponent(outcome) };
}

export async function handleWebRequest(
  manager: BdPayGate,
  request: Request,
  params?: { gateway: string; outcome: string },
): Promise<Response> {
  const route = params ?? matchPath(manager.prefix, new URL(request.url).pathname);

  if (!route) {
    return toWebResponse(json(404, { ok: false, reason: 'not found' }));
  }

  return toWebResponse(
    await manager.handleCallback(route.gateway, route.outcome, await inputFromRequest(request)),
  );
}
