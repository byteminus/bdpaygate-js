import type { Cache } from './cache.js';
import {
  ConfigurationError,
  GatewayError,
  GatewayUnavailableError,
  InvalidCallbackError,
  UnsupportedOperationError,
} from './errors.js';
import type { Emitter } from './events.js';
import { type FetchLike, type HttpRequest, type HttpResponse, send } from './http.js';
import { newGatewayReference, randomString, ulid } from './ids.js';
import {
  isPaid,
  isPending,
  logGatewayResponse,
  refundableAmount,
  statusesThatCanMoveTo,
  toFixed2,
} from './payment.js';
import type { CallbackRequest } from './request.js';
import type { PaymentStore } from './store.js';
import {
  type CallbackResult,
  type Capabilities,
  type ChargeOptions,
  type JsonObject,
  type Logger,
  type Outcome,
  type Payment,
  PaymentStatus,
  type RefundResult,
} from './types.js';
import { sha256Hex, sleep } from './util.js';

/** Settings every gateway accepts, plus its own credentials. */
export interface GatewayConfig {
  /** The driver to use. Defaults to the gateway's name, so `bkash: {...}` uses the bKash driver. */
  driver?: string;
  /** Use the gateway's sandbox. Defaults to true: set it to false explicitly for live payments. */
  sandbox?: boolean;
  /** Override the API host. */
  baseUrl?: string;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** A fetch to use for this gateway, e.g. one with a proxy dispatcher for IP-whitelisted gateways. */
  fetch?: FetchLike;
  [key: string]: unknown;
}

/** What the manager gives each gateway. */
export interface GatewayContext {
  store: PaymentStore;
  cache: Cache;
  events: Emitter;
  logger: Logger;
  currency: string;
  /** Absolute URL the callback routes are mounted at, e.g. https://shop.com.bd/bdpaygate */
  callbackBase: string;
  fetch: FetchLike;
  timeoutMs: number;
  production: boolean;
}

/** The public surface of every gateway. */
export interface Gateway {
  readonly name: string;
  readonly driver: string;
  readonly capabilities: Capabilities;
  readonly sandbox: boolean;
  charge(options: ChargeOptions): Promise<Payment>;
  handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult>;
  sync(payment: Payment): Promise<Payment>;
  refund(payment: Payment, amount?: number | string | null, reason?: string | null): Promise<RefundResult>;
}

/**
 * Shared machinery for drivers: payment bookkeeping, verified transitions,
 * HTTP, token caching, locks and refund accounting. A driver implements
 * charge() and handleCallback(), and sync() / requestRefund() when the
 * gateway has those APIs (declaring them in `capabilities`).
 */
export abstract class AbstractGateway implements Gateway {
  /** The driver type, as used in a gateway's "driver" config key. */
  static readonly driver: string = '';

  readonly capabilities: Capabilities = { sync: false, refunds: false };

  constructor(
    protected readonly config: GatewayConfig,
    /** The config key this gateway was resolved under. Two stores of one driver get different names, routes and payments. */
    readonly name: string,
    protected readonly ctx: GatewayContext,
  ) {}

  get driver(): string {
    return (this.constructor as typeof AbstractGateway).driver;
  }

  get sandbox(): boolean {
    return this.config.sandbox !== false;
  }

  abstract charge(options: ChargeOptions): Promise<Payment>;

  /**
   * Handle the customer being sent back from the gateway, or a server-to-server
   * notification. Nothing in the request is trusted: the outcome is always
   * confirmed with the gateway before the payment changes state.
   */
  abstract handleCallback(request: CallbackRequest, outcome: Outcome): Promise<CallbackResult>;

  /** Ask the gateway for the current state of a payment and apply it. */
  async sync(_payment: Payment): Promise<Payment> {
    throw new UnsupportedOperationError(`${this.name} has no status API.`, this.name);
  }

  /**
   * Refund through the gateway's API. Null refunds everything still
   * refundable. One refund per payment runs at a time.
   */
  async refund(
    payment: Payment,
    amount?: number | string | null,
    reason?: string | null,
  ): Promise<RefundResult> {
    if (!this.capabilities.refunds) {
      throw new UnsupportedOperationError(
        `${this.name} has no refund API. Refund from the merchant panel.`,
        this.name,
      );
    }

    return this.withLock(`refund:${payment.id}`, 60, 15, async () => {
      const fresh = await this.reload(payment);
      const value = this.assertRefundable(fresh, amount);
      const result = await this.recordRefund(fresh, await this.requestRefund(fresh, value, reason ?? null));
      Object.assign(payment, result.payment);

      return result;
    });
  }

  /** Ask the gateway to refund. `amount` is already validated and normalised. */
  protected async requestRefund(
    _payment: Payment,
    _amount: string,
    _reason: string | null,
  ): Promise<RefundResult> {
    throw new UnsupportedOperationError(`${this.name} has no refund API.`, this.name);
  }

  // ---------------------------------------------------------------- config

  /** A config value that must be set. */
  protected credential(key: string): string {
    const value = this.config[key];

    if ((typeof value !== 'string' && typeof value !== 'number') || String(value) === '') {
      throw new ConfigurationError(`Missing [${key}] in the [${this.name}] gateway config.`, this.name);
    }

    return String(value);
  }

  /** An optional config value as a string. */
  protected option(key: string, fallback = ''): string {
    const value = this.config[key];

    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : fallback;
  }

  /** The API base URL: an explicit `baseUrl` wins, otherwise sandbox or live. */
  protected endpoint(sandbox: string, live: string): string {
    const override = this.config.baseUrl;

    return (
      typeof override === 'string' && override !== '' ? override : this.sandbox ? sandbox : live
    ).replace(/\/+$/, '');
  }

  protected get currency(): string {
    return this.ctx.currency;
  }

  // ---------------------------------------------------------------- http

  protected http(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
    return send(this.config.fetch ?? this.ctx.fetch, url, request, {
      timeoutMs: this.config.timeout ?? this.ctx.timeoutMs,
      gateway: this.name,
    });
  }

  /** The absolute URL a gateway should send the customer or its notification to. */
  protected callbackUrl(outcome: Outcome, query: Record<string, string> = {}): string {
    const url = `${this.ctx.callbackBase}/${encodeURIComponent(this.name)}/${outcome}`;
    const qs = new URLSearchParams(query).toString();

    return qs ? `${url}?${qs}` : url;
  }

  // ---------------------------------------------------------------- payments

  /** Normalise any amount to a "1234.50" string: gateways are picky and floats drift. */
  protected amount(value: number | string | null | undefined): string {
    const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());

    if (!Number.isFinite(number) || number <= 0 || String(value ?? '').trim() === '') {
      throw new GatewayError('Amount must be greater than zero.', this.name);
    }

    return toFixed2(number);
  }

  protected async createPendingPayment(options: ChargeOptions): Promise<Payment> {
    const { reference } = options;

    if (typeof reference !== 'string' || reference === '' || [...reference].length > 64) {
      throw new GatewayError('Reference must be 1 to 64 characters.', this.name);
    }

    const amount = this.amount(options.amount);

    // Fail before anything is stored when the app's public URL is not configured.
    void this.ctx.callbackBase;

    if (await this.ctx.store.hasPaidAttempt(this.name, reference)) {
      throw new GatewayError(`Reference [${reference}] has already been paid.`, this.name);
    }

    const now = new Date();
    const customer = options.customer;
    const payment: Payment = {
      id: ulid(now.getTime()),
      gateway: this.name,
      reference,
      gatewayReference: await this.newGatewayReference(),
      gatewayPaymentId: null,
      gatewayTransactionId: null,
      amount,
      refundedAmount: '0.00',
      currency: this.currency,
      status: PaymentStatus.Pending,
      requiresReview: false,
      failureReason: null,
      description: options.description ?? null,
      checkoutUrl: null,
      customer: {
        name: customer.name ?? '',
        phone: customer.phone ?? '',
        email: customer.email ?? null,
        address: customer.address ?? null,
        city: customer.city ?? 'Dhaka',
        country: customer.country ?? 'Bangladesh',
        postcode: customer.postcode ?? null,
        state: customer.state ?? null,
        ...(customer.ip ? { ip: customer.ip } : {}),
      },
      meta: options.meta ?? null,
      gatewayResponse: [],
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.ctx.store.insert(payment);

    return payment;
  }

  /**
   * The id each attempt is sent to the gateway with. Override when a gateway
   * needs another format (the default is "BP" + 18 uppercase alphanumerics).
   */
  protected async newGatewayReference(): Promise<string> {
    return newGatewayReference();
  }

  /** Write the payment as it is now. */
  protected async save(payment: Payment): Promise<Payment> {
    payment.updatedAt = new Date();
    await this.ctx.store.update(payment);

    return payment;
  }

  /** The stored version of a payment (mutating the one given to match). */
  protected async reload(payment: Payment): Promise<Payment> {
    const fresh = await this.ctx.store.find(payment.id);

    if (!fresh) {
      throw new InvalidCallbackError(`Payment [${payment.id}] no longer exists.`, this.name);
    }

    return Object.assign(payment, fresh);
  }

  protected log(payment: Payment, step: string, payload: JsonObject): Payment {
    return logGatewayResponse(payment, step, payload);
  }

  protected async findByGatewayReference(gatewayReference: string): Promise<Payment> {
    const payment =
      gatewayReference === ''
        ? null
        : await this.ctx.store.findBy(this.name, 'gatewayReference', gatewayReference);

    if (!payment) {
      throw new InvalidCallbackError(`Unknown payment [${gatewayReference}].`, this.name);
    }

    return payment;
  }

  protected async findByGatewayPaymentId(id: string): Promise<Payment> {
    const payment = id === '' ? null : await this.ctx.store.findBy(this.name, 'gatewayPaymentId', id);

    if (!payment) {
      throw new InvalidCallbackError(`Unknown gateway payment id [${id}].`, this.name);
    }

    return payment;
  }

  protected assertAmountMatches(payment: Payment, reported: unknown, currency?: string | null): void {
    const text = typeof reported === 'number' || typeof reported === 'string' ? String(reported).trim() : '';
    const number = Number(text);
    const matches =
      text !== '' && Number.isFinite(number) && number > 0 && toFixed2(number) === payment.amount;

    if (!matches) {
      throw new InvalidCallbackError(
        `Amount mismatch for [${payment.gatewayReference}]: expected ${payment.amount}, gateway reported ${text || 'nothing'}.`,
        this.name,
      );
    }

    if (currency && currency.toUpperCase() !== payment.currency.toUpperCase()) {
      throw new InvalidCallbackError(
        `Currency mismatch for [${payment.gatewayReference}]: expected ${payment.currency}, gateway reported ${currency}.`,
        this.name,
      );
    }
  }

  /**
   * Move a payment to a new state at most once, and fire the matching event.
   *
   * The write is conditional on the stored status, so two requests racing
   * (an IPN and the customer's redirect arriving together) cannot both win:
   * exactly one fires the event.
   */
  protected async transition(
    payment: Payment,
    status: PaymentStatus,
    attributes: Partial<Payment> = {},
    step = 'callback',
    raw: JsonObject = {},
  ): Promise<CallbackResult> {
    const from = statusesThatCanMoveTo(status);

    if (from.length === 0) {
      return { payment, status: payment.status, changed: false };
    }

    const next: Payment = { ...payment, ...attributes, status, updatedAt: new Date() };

    if (status === PaymentStatus.Completed && !next.paidAt) {
      next.paidAt = new Date();
    }

    if (Object.keys(raw).length > 0) {
      logGatewayResponse(next, step, raw);
    }

    const updated = await this.ctx.store.update(next, from);
    await this.reload(payment);

    if (!updated) {
      return { payment, status: payment.status, changed: false };
    }

    if (status === PaymentStatus.Completed) {
      const duplicate = await this.ctx.store.hasPaidAttempt(payment.gateway, payment.reference, payment.id);
      await this.ctx.events.emit(duplicate ? 'payment.duplicated' : 'payment.completed', { payment });
    } else if (status === PaymentStatus.Failed) {
      await this.ctx.events.emit('payment.failed', { payment });
    } else if (status === PaymentStatus.Cancelled) {
      await this.ctx.events.emit('payment.cancelled', { payment });
    }

    return { payment, status, changed: true };
  }

  /** Record what the gateway said without changing state: it could not confirm either way yet. */
  protected async stillPending(
    payment: Payment,
    step: string,
    raw: JsonObject = {},
  ): Promise<CallbackResult> {
    if (Object.keys(raw).length > 0) {
      await this.save(logGatewayResponse(payment, step, raw));
    }

    return { payment, status: payment.status, changed: false };
  }

  /** The result for a payment a callback does not change (already settled). */
  protected unchanged(payment: Payment): CallbackResult {
    return { payment, status: payment.status, changed: false };
  }

  protected isPaid(payment: Payment): boolean {
    return isPaid(payment);
  }

  protected isPending(payment: Payment): boolean {
    return isPending(payment);
  }

  // ---------------------------------------------------------------- refunds

  protected assertRefundable(payment: Payment, amount: number | string | null | undefined): string {
    if (!isPaid(payment)) {
      throw new GatewayError(`Payment [${payment.reference}] is not paid, nothing to refund.`, this.name);
    }

    const refundable = refundableAmount(payment);
    const value = this.amount(amount ?? refundable);

    if (Number(value) > Number(refundable)) {
      throw new GatewayError(`Refund of ${value} exceeds the refundable ${refundable}.`, this.name);
    }

    if (Number(value) < Number(payment.amount) && this.capabilities.refunds !== 'partial') {
      throw new UnsupportedOperationError(`${this.name} only refunds the full amount.`, this.name);
    }

    return value;
  }

  protected async recordRefund(payment: Payment, result: RefundResult): Promise<RefundResult> {
    if (result.accepted) {
      payment.refundedAmount = toFixed2(Number(payment.refundedAmount) + Number(result.amount));
      payment.status =
        Number(payment.refundedAmount) >= Number(payment.amount)
          ? PaymentStatus.Refunded
          : PaymentStatus.PartiallyRefunded;
    }

    await this.save(logGatewayResponse(payment, result.accepted ? 'refund' : 'refund_rejected', result.raw));

    const recorded = { ...result, payment };

    if (result.accepted) {
      await this.ctx.events.emit('refund.processed', { payment, refund: recorded });
    }

    return recorded;
  }

  protected refundResult(
    payment: Payment,
    result: Partial<RefundResult> & { accepted: boolean; amount: string },
  ): RefundResult {
    return {
      payment,
      pending: false,
      refundId: null,
      message: null,
      raw: {},
      ...result,
    };
  }

  // ---------------------------------------------------------------- cache and locks

  protected async tokenCacheKey(key: string): Promise<string> {
    return `bdpaygate:token:${this.name}:${(await sha256Hex(`${key}:${this.sandbox ? 'sandbox' : 'live'}`)).slice(0, 32)}`;
  }

  /**
   * Cache an access token, letting only one process fetch a new one. Some
   * gateways (bKash) lock the merchant out for an hour after a few grants.
   */
  protected async rememberToken(
    key: string,
    fetch: () => Promise<[token: string, ttlSeconds: number]>,
  ): Promise<string> {
    const cacheKey = await this.tokenCacheKey(key);
    const cached = await this.ctx.cache.get(cacheKey);

    if (typeof cached === 'string' && cached !== '') {
      return cached;
    }

    return this.withLock(`${cacheKey}:lock`, 30, 20, async () => {
      const again = await this.ctx.cache.get(cacheKey);

      if (typeof again === 'string' && again !== '') {
        return again;
      }

      const [token, ttl] = await fetch();
      await this.ctx.cache.set(cacheKey, token, Math.max(30, ttl));

      return token;
    });
  }

  protected async forgetToken(key: string): Promise<void> {
    await this.ctx.cache.delete(await this.tokenCacheKey(key));
  }

  /** Take a lock without waiting. Returns a release function, or null when someone else holds it. */
  protected async tryLock(key: string, ttlSeconds: number): Promise<(() => Promise<void>) | null> {
    const lockKey = `bdpaygate:lock:${key}`;
    const owner = randomString(16);

    if (!(await this.ctx.cache.add(lockKey, owner, ttlSeconds))) {
      return null;
    }

    return async () => {
      if ((await this.ctx.cache.get(lockKey)) === owner) {
        await this.ctx.cache.delete(lockKey);
      }
    };
  }

  /** Run `fn` holding a lock, waiting up to `waitSeconds` for it. */
  protected async withLock<T>(
    key: string,
    ttlSeconds: number,
    waitSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + waitSeconds * 1000;
    let release = await this.tryLock(key, ttlSeconds);

    while (!release) {
      if (Date.now() >= deadline) {
        throw new GatewayUnavailableError(`Timed out waiting for lock [${key}].`, this.name);
      }

      await sleep(100 + Math.random() * 150);
      release = await this.tryLock(key, ttlSeconds);
    }

    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

export type GatewayClass = (new (
  config: GatewayConfig,
  name: string,
  ctx: GatewayContext,
) => AbstractGateway) & {
  readonly driver: string;
};
