/**
 * Koa 2 and 3.
 *
 *     import { bdpaygate } from 'bdpaygate/koa';
 *     app.use(bdpaygate(pay));
 *
 * Works with or without a body parser installed.
 */
import { matchPath } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';
import { type NodeLikeRequest, nodeInput } from './node.js';

interface KoaContextLike {
  path: string;
  req: NodeLikeRequest;
  request: { body?: unknown };
  originalUrl?: string;
  ip?: string;
  status: number;
  body: unknown;
  set(field: string, value: string): void;
}

export function bdpaygate(pay: BdPayGate) {
  return async (ctx: KoaContextLike, next: () => Promise<unknown>): Promise<void> => {
    const route = matchPath(pay.prefix, ctx.path);

    if (!route) {
      await next();

      return;
    }

    if (ctx.request.body !== undefined) {
      ctx.req.body = ctx.request.body;
    }

    const input = await nodeInput(ctx.req);
    const response = await pay.handleCallback(route.gateway, route.outcome, {
      ...input,
      clientIp: ctx.ip ?? input.clientIp,
    });

    for (const [key, value] of Object.entries(response.headers)) {
      ctx.set(key, value);
    }

    ctx.status = response.status;
    ctx.body = response.body ?? '';
  };
}

export { bdpaygate as koaHandler };
