/**
 * SvelteKit, in src/routes/bdpaygate/[gateway]/[outcome]/+server.ts:
 *
 *     import { requestHandlers } from 'bdpaygate/sveltekit';
 *     import { pay } from '$lib/server/payments';
 *     export const { GET, POST } = requestHandlers(pay);
 *
 * SvelteKit blocks cross-site form POSTs by default, and several gateways
 * return the customer with one. Allow the gateway origins in svelte.config.js
 * (kit.csrf.trustedOrigins), see the docs.
 */
import { handleWebRequest } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';

type Event = { request: Request; params: Partial<Record<string, string>> };
type Handler = (event: Event) => Promise<Response>;

export function requestHandlers(pay: BdPayGate): { GET: Handler; POST: Handler } {
  const handler: Handler = ({ request, params }) =>
    handleWebRequest(pay, request, { gateway: params.gateway ?? '', outcome: params.outcome ?? '' });

  return { GET: handler, POST: handler };
}
