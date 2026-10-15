import {
  type BdPayGate,
  createBdPayGate,
  type GatewayConfig,
  type JsonObject,
  MemoryCache,
  MemoryStore,
  type Payment,
} from '../../src/index.js';
import {
  type Handler,
  type MockFetch,
  type MockRequest,
  mockFetch,
  type Routes,
  timeout,
} from './mock-fetch.js';

export const BASE_URL = 'https://shop.test';

/** A request a gateway sends to the package's callback URL. */
export interface CallbackSpec {
  method: 'GET' | 'POST';
  path: string;
  /** Query string for GET, form body for POST (JSON body when `json`). */
  data: JsonObject;
  json?: boolean;
}

export const get = (path: string, data: JsonObject = {}): CallbackSpec => ({ method: 'GET', path, data });
export const post = (path: string, data: JsonObject = {}, json = false): CallbackSpec => ({
  method: 'POST',
  path,
  data,
  json,
});

/**
 * Teaches the conformance suite (tests/conformance.test.ts) how one gateway
 * behaves. Put a file named <gateway>.scenario.ts in tests/conformance and
 * every conformance test runs against it.
 *
 * Handlers must be lazy: the tests flip `state` and `reportedAmount` between
 * requests, so read them inside handlers.
 */
export abstract class GatewayScenario {
  /**
   * What the gateway says when asked about a payment: "paid", "unpaid" (not
   * paid yet / still initiated), "failed" (declined or cancelled), or "down"
   * (no response at all: wrap verification handlers with verification()).
   */
  state: 'paid' | 'unpaid' | 'failed' | 'down' = 'paid';

  /** The amount the gateway reports. Null means the payment's own amount. */
  reportedAmount: string | null = null;

  /** Amount the tests charge. Override if the gateway has a minimum. */
  chargeAmount = '150.00';

  store = new MemoryStore();
  cache = new MemoryCache();
  pay!: BdPayGate;
  http!: MockFetch;

  /** The gateway name used in config and routes. */
  abstract readonly gateway: string;

  /** The gateway's config entry, including `driver`. */
  abstract config(): GatewayConfig;

  /**
   * Handlers for every endpoint the driver calls: create, status/verify,
   * token grants, refunds. Verification handlers must honour `state` and
   * `reportedAmount`.
   */
  abstract routes(): Routes;

  /** What the gateway sends when the customer returns after paying (or claims to have paid). */
  abstract successCallback(payment: Payment): CallbackSpec;

  /** What the gateway sends for a failed or cancelled payment. Null if it has no distinct shape. */
  failureCallback(_payment: Payment): CallbackSpec | null {
    return null;
  }

  /** A callback to deliver before syncing, for gateways that only assign a lookup id once the customer acted. */
  beforeSync(_payment: Payment): CallbackSpec | null {
    return null;
  }

  boot(): this {
    this.http = mockFetch(() => this.routes());
    this.pay = createBdPayGate({
      baseUrl: BASE_URL,
      gateways: { [this.gateway]: this.config() },
      store: this.store,
      cache: this.cache,
      fetch: this.http.fetch,
      logger: { warn() {} },
      redirects: { success: '/paid', failed: '/failed', cancelled: '/cancelled', pending: '/pending' },
    });

    return this;
  }

  /** Wrap a verification handler so state "down" simulates a timeout. */
  protected verification(respond: Handler): Handler {
    return (request: MockRequest) => (this.state === 'down' ? timeout() : respond(request));
  }

  /** The amount the gateway should report for a payment. */
  protected reported(payment: Payment): string {
    return this.reportedAmount ?? payment.amount;
  }

  /** The payment a stubbed request is about. */
  protected async payment(
    fieldName: 'gatewayReference' | 'gatewayPaymentId',
    value: unknown,
  ): Promise<Payment> {
    const payment = await this.store.findBy(this.gateway, fieldName, String(value));

    if (!payment) {
      throw new Error(`No ${this.gateway} payment with ${fieldName} ${String(value)}`);
    }

    return payment;
  }

  /** The most recently created payment for this gateway. */
  protected latestPayment(): Payment {
    const payments = [...this.store.payments.values()].filter((p) => p.gateway === this.gateway);
    const latest = payments.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    )[0];

    if (!latest) {
      throw new Error(`No ${this.gateway} payment yet`);
    }

    return structuredClone(latest);
  }
}

export const customer = () => ({
  name: 'Rahim Uddin',
  phone: '01711000000',
  email: 'rahim@example.com',
  address: 'House 1, Road 2',
});

/** Send a callback through the Web handler, as the gateway would. */
export async function hit(pay: BdPayGate, spec: CallbackSpec): Promise<Response> {
  const url = new URL(spec.path, BASE_URL);

  if (spec.method === 'GET') {
    for (const [key, value] of Object.entries(spec.data)) {
      appendParam(url.searchParams, key, value);
    }

    return pay.fetch(new Request(url, { method: 'GET' }));
  }

  if (spec.json) {
    return pay.fetch(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(spec.data),
      }),
    );
  }

  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(spec.data)) {
    appendParam(form, key, value);
  }

  return pay.fetch(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }),
  );
}

function appendParam(params: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      params.append(`${key}[]`, String(item));
    }
  } else if (value !== undefined && value !== null) {
    params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
}

/** Wrap every value in an array: `?invoice_id=x` becomes `?invoice_id[]=x`. */
export function mangle(spec: CallbackSpec): CallbackSpec {
  return { ...spec, data: Object.fromEntries(Object.entries(spec.data).map(([k, v]) => [k, [v]])) };
}
