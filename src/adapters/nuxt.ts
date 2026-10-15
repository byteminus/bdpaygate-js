/**
 * Nuxt 3/4 and Nitro (h3 v1 and v2), in server/routes/bdpaygate/[gateway]/[outcome].ts:
 *
 *     import { eventHandler } from 'bdpaygate/nuxt';
 *     import { pay } from '~~/server/utils/payments';
 *     export default defineEventHandler(eventHandler(pay));
 */
import { handleWebRequest, toWebResponse } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';
import { type NodeLikeRequest, nodeInput } from './node.js';

interface H3EventLike {
  /** h3 v2: a Web Request. */
  req?: unknown;
  /** h3 v1: Node's req/res. */
  node?: { req: NodeLikeRequest };
  context: { params?: Partial<Record<string, string>> };
}

export function eventHandler(pay: BdPayGate): (event: H3EventLike) => Promise<Response> {
  return async (event) => {
    const params = event.context.params ?? {};
    const route = {
      gateway: decodeURIComponent(params.gateway ?? ''),
      outcome: decodeURIComponent(params.outcome ?? ''),
    };

    if (event.req instanceof Request) {
      return handleWebRequest(pay, event.req, route);
    }

    if (!event.node) {
      return new Response('{"ok":false,"reason":"unsupported runtime"}', { status: 500 });
    }

    return toWebResponse(
      await pay.handleCallback(route.gateway, route.outcome, await nodeInput(event.node.req)),
    );
  };
}
