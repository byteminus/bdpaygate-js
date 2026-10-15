/**
 * React Router 7 (framework mode) and Remix 2, as a resource route in
 * app/routes/bdpaygate.$gateway.$outcome.ts:
 *
 *     import { routeModule } from 'bdpaygate/react-router';
 *     import { pay } from '~/payments.server';
 *     export const { loader, action } = routeModule(pay);
 */
import { handleWebRequest } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';

type Args = { request: Request; params: Partial<Record<string, string>> };
type Handler = (args: Args) => Promise<Response>;

export function routeModule(pay: BdPayGate): { loader: Handler; action: Handler } {
  const handler: Handler = ({ request, params }) =>
    handleWebRequest(pay, request, { gateway: params.gateway ?? '', outcome: params.outcome ?? '' });

  return { loader: handler, action: handler };
}

export { routeModule as remixRouteModule };
