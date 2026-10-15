/**
 * Express 4 and 5.
 *
 *     import { bdpaygate } from 'bdpaygate/express';
 *     app.use(bdpaygate(pay)); // before any CSRF or auth middleware
 *
 * Works with or without express.json()/express.urlencoded() installed.
 */
import type { BdPayGate } from '../core/manager.js';
import { nodeHandler } from './node.js';

export type { NextFunction, NodeLikeRequest, NodeLikeResponse } from './node.js';

export function bdpaygate(pay: BdPayGate): ReturnType<typeof nodeHandler> {
  return nodeHandler(pay);
}

export { bdpaygate as expressHandler };
