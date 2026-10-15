/**
 * Web-standard handlers: (Request) => Response. For Bun.serve, Deno.serve,
 * Cloudflare Workers, Vercel/Netlify functions, and any framework built on
 * the Fetch API. `pay.fetch` is the same thing.
 */
import { handleWebRequest } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';

export type WebHandler = (request: Request) => Promise<Response>;

/** Handles `${prefix}/{gateway}/{outcome}`; anything else gets a 404. */
export function webHandler(pay: BdPayGate): WebHandler {
  return (request) => handleWebRequest(pay, request);
}

/** For routers that already extracted the route params. */
export function webRouteHandler(
  pay: BdPayGate,
): (request: Request, params: { gateway: string; outcome: string }) => Promise<Response> {
  return (request, params) => handleWebRequest(pay, request, params);
}
