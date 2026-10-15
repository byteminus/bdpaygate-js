import { FakeGateway } from '../drivers/fake.js';
import { DRIVERS } from '../drivers/index.js';
import { MemoryStore } from '../stores/memory.js';
import { type Cache, MemoryCache } from './cache.js';
import { ConfigurationError, GatewayError, UnsupportedOperationError } from './errors.js';
import { Emitter, type EventName, type Listener } from './events.js';
import type { Gateway, GatewayClass, GatewayConfig, GatewayContext } from './gateway.js';
import { type CallbackResponse, handleCallback, handleWebRequest } from './handler.js';
import type { FetchLike } from './http.js';
import type { CallbackInput } from './request.js';
import type { PaymentStore } from './store.js';
import type { ChargeOptions, Logger, Payment, RefundResult } from './types.js';

export type RedirectKey = 'success' | 'failed' | 'cancelled' | 'pending';

/** A URL (relative or absolute), or a function returning one. `?payment={id}` is appended to URLs. */
export type RedirectTarget = string | ((payment: Payment | null) => string);

export interface BdPayGateConfig {
  /**
   * Your app's public URL, e.g. https://shop.com.bd. Gateways call back to
   * `${baseUrl}${prefix}/{gateway}/{outcome}`, so it must be reachable from
   * the internet (use a tunnel in development).
   */
  baseUrl?: string;
  /** Where the callback routes are mounted. Default "/bdpaygate". */
  prefix?: string;
  /** The gateway charge() uses when none is named. Defaults to the first configured one. */
  default?: string;
  /** Keyed by gateway name. The key is also the driver unless `driver` is set. */
  gateways: Record<string, GatewayConfig>;
  /** Where payments are stored. Defaults to memory: fine for tests, not for production. */
  store?: PaymentStore;
  /** Tokens and locks. Defaults to memory: use Redis when you run more than one process. */
  cache?: Cache;
  /** Where the customer lands after the gateway returns them, by outcome. Default "/" for all. */
  redirects?: Partial<Record<RedirectKey, RedirectTarget>>;
  currency?: string;
  /** Request timeout for gateway calls in milliseconds. Default 30000. */
  timeout?: number;
  /** The fetch used for gateway calls. Pass one with a proxy dispatcher for IP-whitelisted gateways (Nagad, Upay). */
  fetch?: FetchLike;
  /** Default: console. Pass `{ warn() {} }` to silence. */
  logger?: Logger;
  /** Disables the fake gateway's callbacks. Default: NODE_ENV === "production". */
  production?: boolean;
}

export type GatewayFactory = (config: GatewayConfig, name: string, ctx: GatewayContext) => Gateway;

export interface SyncPendingOptions {
  gateway?: string;
  /** Minutes a payment must have been pending. Default 15. */
  olderThanMinutes?: number;
  /** Ignore payments pending longer than this. Default 2880 (two days). */
  maxAgeMinutes?: number;
  /** Payments per run. Default 200. */
  limit?: number;
}

export interface SyncPendingResult {
  checked: number;
  settled: number;
  errors: { paymentId: string; gateway: string; message: string }[];
}

function readProductionFlag(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

  return env?.NODE_ENV === 'production';
}

/**
 * One API for every gateway. Create it once and share it:
 *
 *     export const payments = createBdPayGate({ baseUrl: 'https://shop.com.bd', gateways: { bkash: {...} }, store });
 */
export class BdPayGate {
  readonly store: PaymentStore;
  readonly cache: Cache;
  readonly prefix: string;
  private readonly emitter = new Emitter();
  private readonly instances = new Map<string, Gateway>();
  private readonly factories = new Map<string, GatewayFactory>();
  private defaultGateway: string | undefined;

  constructor(private readonly config: BdPayGateConfig) {
    this.store = config.store ?? new MemoryStore();
    this.cache = config.cache ?? new MemoryCache();
    this.prefix = `/${(config.prefix ?? '/bdpaygate').replace(/^\/+|\/+$/g, '')}`;
    this.defaultGateway = config.default ?? Object.keys(config.gateways)[0];
  }

  /** The callback route pattern, for frameworks that register routes themselves. */
  get routePattern(): string {
    return `${this.prefix}/:gateway/:outcome`;
  }

  /** A gateway by its config name. */
  gateway(name: string | undefined = this.defaultGateway): Gateway {
    if (!name) {
      throw new ConfigurationError('No gateway configured.');
    }

    const existing = this.instances.get(name);

    if (existing) {
      return existing;
    }

    const config = this.config.gateways[name];

    if (!config) {
      throw new ConfigurationError(`Gateway [${name}] is not configured.`);
    }

    const driver = config.driver ?? name;
    const factory = this.factories.get(driver);
    const builtIn: GatewayClass | undefined = DRIVERS[driver];

    if (!factory && !builtIn) {
      throw new ConfigurationError(`Gateway driver [${driver}] is not supported.`);
    }

    const ctx = this.context();
    const gateway = factory ? factory(config, name, ctx) : new (builtIn as GatewayClass)(config, name, ctx);
    this.instances.set(name, gateway);

    return gateway;
  }

  /** Whether a gateway name is configured. */
  has(name: string): boolean {
    return name in this.config.gateways;
  }

  /** Create a payment on a gateway (default: the default gateway) and return it with its checkoutUrl. */
  async charge(options: ChargeOptions & { gateway?: string }): Promise<Payment> {
    const { gateway, ...rest } = options;

    return this.gateway(gateway).charge(rest);
  }

  /** The gateway a payment was made with. */
  for(payment: Payment): Gateway {
    return this.gateway(payment.gateway);
  }

  find(id: string): Promise<Payment | null> {
    return this.store.find(id);
  }

  /** Every attempt for one of your references on a gateway, oldest first. */
  attempts(reference: string, gateway: string | undefined = this.defaultGateway): Promise<Payment[]> {
    return this.store.attempts(gateway ?? '', reference);
  }

  /** Ask the payment's gateway for its current state, and apply it. */
  async sync(payment: Payment): Promise<Payment> {
    const gateway = this.for(payment);

    if (!gateway.capabilities.sync) {
      throw new UnsupportedOperationError(`${gateway.name} has no status API.`, gateway.name);
    }

    return gateway.sync(payment);
  }

  /** Refund through the payment's gateway. Null or omitted refunds everything still refundable. */
  async refund(
    payment: Payment,
    amount?: number | string | null,
    reason?: string | null,
  ): Promise<RefundResult> {
    return this.for(payment).refund(payment, amount, reason);
  }

  /**
   * Settle payments whose callback never arrived. Run it on a schedule
   * (every 10 minutes is good): a cron job, a queue, or a protected route.
   */
  async syncPending(options: SyncPendingOptions = {}): Promise<SyncPendingResult> {
    const now = Date.now();
    const payments = await this.store.pending({
      gateway: options.gateway,
      createdBefore: new Date(now - (options.olderThanMinutes ?? 15) * 60_000),
      createdAfter: new Date(now - (options.maxAgeMinutes ?? 2880) * 60_000),
      limit: options.limit ?? 200,
    });
    const result: SyncPendingResult = { checked: 0, settled: 0, errors: [] };

    for (const payment of payments) {
      let gateway: Gateway;

      try {
        gateway = this.for(payment);
      } catch {
        continue;
      }

      if (!gateway.capabilities.sync) {
        continue;
      }

      result.checked++;

      try {
        if ((await gateway.sync(payment)).status !== 'pending') {
          result.settled++;
        }
      } catch (error) {
        if (!(error instanceof GatewayError)) {
          throw error;
        }

        result.errors.push({ paymentId: payment.id, gateway: payment.gateway, message: error.message });
      }
    }

    return result;
  }

  /**
   * Handle a request to `${prefix}/{gateway}/{outcome}` from any framework.
   * Adapters call this; use it directly for a framework without one.
   */
  handleCallback(gateway: string, outcome: string, input: CallbackInput): Promise<CallbackResponse> {
    return handleCallback(this, gateway, outcome, input, this.config.redirects ?? {}, this.logger);
  }

  /** A Web-standard handler: (Request) => Response. Works in Bun, Deno, Workers, Hono, Next.js and more. */
  readonly fetch = (request: Request): Promise<Response> => handleWebRequest(this, request);

  /** Listen for an event. Returns a function that removes the listener. */
  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    return this.emitter.on(event, listener);
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    this.emitter.off(event, listener);
  }

  /** Register a custom driver: `extend('mygateway', (config, name, ctx) => new MyGateway(config, name, ctx))`. */
  extend(driver: string, factory: GatewayFactory): this {
    this.factories.set(driver, factory);

    for (const [name, config] of Object.entries(this.config.gateways)) {
      if ((config.driver ?? name) === driver) {
        this.instances.delete(name);
      }
    }

    return this;
  }

  /** Make the fake gateway the default, for tests. Its checkout URL completes the payment. */
  fake(): FakeGateway {
    this.config.gateways.fake ??= { driver: 'fake' };
    this.defaultGateway = 'fake';
    const gateway = this.gateway('fake');

    if (!(gateway instanceof FakeGateway)) {
      throw new ConfigurationError('The fake gateway is not registered.');
    }

    return gateway;
  }

  private get logger(): Logger {
    return this.config.logger ?? console;
  }

  private context(): GatewayContext {
    const base = this.config.baseUrl?.replace(/\/+$/, '');
    const prefix = this.prefix;

    return {
      store: this.store,
      cache: this.cache,
      events: this.emitter,
      logger: this.logger,
      currency: this.config.currency ?? 'BDT',
      get callbackBase(): string {
        if (!base) {
          throw new ConfigurationError('Set baseUrl (your public app URL) so gateways can call back.');
        }

        return base + prefix;
      },
      fetch: this.config.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      timeoutMs: this.config.timeout ?? 30_000,
      production: this.config.production ?? readProductionFlag(),
    };
  }
}

export function createBdPayGate(config: BdPayGateConfig): BdPayGate {
  return new BdPayGate(config);
}
