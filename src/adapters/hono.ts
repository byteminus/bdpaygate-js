/**
 * Hono, on any runtime.
 *
 *     import { bdpaygate } from 'bdpaygate/hono';
 *     app.all('/bdpaygate/:gateway/:outcome', bdpaygate(pay));
 */
import { handleWebRequest } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';

interface HonoContextLike {
  req: { raw: Request; param(name: string): string | undefined };
}

export function bdpaygate(pay: BdPayGate): (c: HonoContextLike) => Promise<Response> {
  return (c) =>
    handleWebRequest(pay, c.req.raw, {
      gateway: c.req.param('gateway') ?? '',
      outcome: c.req.param('outcome') ?? '',
    });
}

export { bdpaygate as honoHandler };
