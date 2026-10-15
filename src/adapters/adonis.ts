/**
 * AdonisJS 6, in start/routes.ts:
 *
 *     import { routeHandler } from 'bdpaygate/adonis';
 *     import { pay } from '#services/payments';
 *     router.any('/bdpaygate/:gateway/:outcome', routeHandler(pay));
 *
 * Exempt the routes from Shield's CSRF check in config/shield.ts:
 * csrf.exceptRoutes: (ctx) => ctx.request.url().startsWith('/bdpaygate/')
 */
import type { BdPayGate } from '../core/manager.js';
import type { JsonObject } from '../core/types.js';

interface AdonisContextLike {
  params: Record<string, string | undefined>;
  request: {
    method(): string;
    qs(): JsonObject;
    body(): JsonObject;
    headers(): Record<string, string | string[] | undefined>;
    raw?(): string | null;
    ip?(): string;
  };
  response: {
    status(code: number): unknown;
    header(key: string, value: string): unknown;
    send(body: unknown): unknown;
  };
}

export function routeHandler(pay: BdPayGate): (ctx: AdonisContextLike) => Promise<void> {
  return async ({ params, request, response }) => {
    const headers = Object.fromEntries(
      Object.entries(request.headers())
        .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
    );
    const result = await pay.handleCallback(params.gateway ?? '', params.outcome ?? '', {
      method: request.method(),
      query: request.qs(),
      body: request.body(),
      headers,
      rawBody: request.raw?.() ?? undefined,
      clientIp: request.ip?.(),
    });

    for (const [key, value] of Object.entries(result.headers)) {
      response.header(key, value);
    }

    response.status(result.status);
    response.send(result.body ?? '');
  };
}
