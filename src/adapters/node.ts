/**
 * Node's http module, and anything that hands you (req, res): Connect,
 * Polka, NestJS middleware, the Next.js Pages Router.
 */
import { matchPath, parseBody, parseParams } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';
import type { CallbackInput } from '../core/request.js';
import type { JsonObject } from '../core/types.js';

export interface NodeLikeRequest extends AsyncIterable<unknown> {
  method?: string;
  url?: string;
  /** Express keeps the full path here when the app is mounted under a sub-path. */
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Set when a body parser already ran. */
  body?: unknown;
  readableEnded?: boolean;
  /** Express sets this, honouring "trust proxy". */
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface NodeLikeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
  headersSent?: boolean;
}

export type NextFunction = (error?: unknown) => void;

function flatHeaders(headers: NodeLikeRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  return out;
}

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array;

async function readStream(req: NodeLikeRequest): Promise<string> {
  if (req.readableEnded) {
    return '';
  }

  const decoder = new TextDecoder();
  let text = '';

  for await (const chunk of req) {
    text += typeof chunk === 'string' ? chunk : isBytes(chunk) ? decoder.decode(chunk, { stream: true }) : '';

    if (text.length > 1_000_000) {
      break;
    }
  }

  return text + decoder.decode();
}

/**
 * Callback input from a Node request. Uses `req.body` when a body parser
 * already ran (as an object, string or Buffer), otherwise reads the stream.
 */
export async function nodeInput(req: NodeLikeRequest): Promise<CallbackInput> {
  const url = new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost');
  const headers = flatHeaders(req.headers);
  const method = (req.method ?? 'GET').toUpperCase();
  let body: JsonObject = {};
  let rawBody: string | undefined;

  if (method !== 'GET' && method !== 'HEAD') {
    if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !isBytes(req.body)) {
      body = req.body as JsonObject;
    } else {
      rawBody =
        typeof req.body === 'string'
          ? req.body
          : isBytes(req.body)
            ? new TextDecoder().decode(req.body)
            : await readStream(req);
      body = parseBody(headers['content-type'], rawBody);
    }
  }

  return {
    method,
    query: parseParams(url.searchParams),
    body,
    headers,
    rawBody,
    clientIp: req.ip ?? req.socket?.remoteAddress,
  };
}

/** Send a framework-neutral response through a Node response. */
export function sendNode(
  res: NodeLikeResponse,
  response: { status: number; headers: Record<string, string>; body: string | null },
): void {
  res.statusCode = response.status;

  for (const [key, value] of Object.entries(response.headers)) {
    res.setHeader(key, value);
  }

  res.end(response.body ?? undefined);
}

/**
 * (req, res, next) middleware. Handles `${prefix}/{gateway}/{outcome}` and
 * passes everything else to `next` (or answers 404 without one).
 *
 *     http.createServer(nodeHandler(pay))
 */
export function nodeHandler(pay: BdPayGate) {
  return async (req: NodeLikeRequest, res: NodeLikeResponse, next?: NextFunction): Promise<void> => {
    const route = matchPath(
      pay.prefix,
      new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost').pathname,
    );

    if (!route) {
      if (next) {
        next();
      } else {
        sendNode(res, {
          status: 404,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":false,"reason":"not found"}',
        });
      }

      return;
    }

    try {
      sendNode(res, await pay.handleCallback(route.gateway, route.outcome, await nodeInput(req)));
    } catch (error) {
      if (next) {
        next(error);

        return;
      }

      throw error;
    }
  };
}
