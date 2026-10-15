/**
 * NestJS, on the Express or the Fastify platform. Nest middleware receives
 * Node's req/res on both, so one handler serves both.
 *
 *     // main.ts, before app.listen():
 *     app.use(bdpaygateMiddleware(pay));
 *
 * Or in a module, with the payments instance from a provider:
 *
 *     export class AppModule implements NestModule {
 *       constructor(@Inject(BDPAYGATE) private readonly pay: BdPayGate) {}
 *       configure(consumer: MiddlewareConsumer) {
 *         consumer.apply(bdpaygateMiddleware(this.pay)).forRoutes('bdpaygate');
 *       }
 *     }
 *
 * Keep CSRF guards off these routes: gateways return customers with a cross-site POST.
 */
import type { BdPayGate } from '../core/manager.js';
import { nodeHandler } from './node.js';

/** Injection token for a BdPayGate instance, if you register it as a provider. */
export const BDPAYGATE = Symbol.for('bdpaygate');

export function bdpaygateMiddleware(pay: BdPayGate): ReturnType<typeof nodeHandler> {
  return nodeHandler(pay);
}

/**
 * A provider for Nest's DI: `providers: [bdpaygateProvider(() => createBdPayGate({...}))]`,
 * then `@Inject(BDPAYGATE) pay: BdPayGate`.
 */
export function bdpaygateProvider(factory: () => BdPayGate | Promise<BdPayGate>): {
  provide: symbol;
  useFactory: () => BdPayGate | Promise<BdPayGate>;
} {
  return { provide: BDPAYGATE, useFactory: factory };
}
