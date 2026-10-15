/**
 * Next.js.
 *
 * App Router, in app/bdpaygate/[gateway]/[outcome]/route.ts:
 *
 *     import { routeHandlers } from 'bdpaygate/next';
 *     import { pay } from '@/lib/payments';
 *     export const { GET, POST } = routeHandlers(pay);
 *
 * Pages Router, in pages/api/bdpaygate/[gateway]/[outcome].ts (with prefix "/api/bdpaygate"):
 *
 *     export default pagesHandler(pay);
 */
import { handleWebRequest } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';
import { nodeHandler } from './node.js';

type Params = { gateway: string; outcome: string };
type RouteContext = { params: Params | Promise<Params> };
type RouteHandler = (request: Request, context: RouteContext) => Promise<Response>;

export function routeHandlers(pay: BdPayGate): { GET: RouteHandler; POST: RouteHandler } {
  const handler: RouteHandler = async (request, context) =>
    handleWebRequest(pay, request, await context.params);

  return { GET: handler, POST: handler };
}

/** Pages Router API route. Works with Next's default body parser on or off. */
export function pagesHandler(pay: BdPayGate): ReturnType<typeof nodeHandler> {
  return nodeHandler(pay);
}
