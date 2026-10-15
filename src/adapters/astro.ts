/**
 * Astro (server or hybrid output), in src/pages/bdpaygate/[gateway]/[outcome].ts:
 *
 *     import { endpoints } from 'bdpaygate/astro';
 *     import { pay } from '../../../lib/payments';
 *     export const prerender = false;
 *     export const { GET, POST } = endpoints(pay);
 *
 * Astro's security.checkOrigin blocks cross-site form POSTs, which several
 * gateways use to return the customer: see the docs for the setting.
 */
import { handleWebRequest } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';

type Context = { request: Request; params: Partial<Record<string, string | undefined>> };
type Handler = (context: Context) => Promise<Response>;

export function endpoints(pay: BdPayGate): { GET: Handler; POST: Handler } {
  const handler: Handler = ({ request, params }) =>
    handleWebRequest(pay, request, { gateway: params.gateway ?? '', outcome: params.outcome ?? '' });

  return { GET: handler, POST: handler };
}
