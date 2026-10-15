# BDPayGate: Bangladesh payment gateways for Node.js

[![npm](https://img.shields.io/npm/v/bdpaygate)](https://www.npmjs.com/package/bdpaygate)
[![CI](https://github.com/byteminus/bdpaygate-js/actions/workflows/ci.yml/badge.svg)](https://github.com/byteminus/bdpaygate-js/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/bdpaygate)](https://www.npmjs.com/package/bdpaygate)
[![license](https://img.shields.io/npm/l/bdpaygate)](LICENSE)

Website and docs: **https://bdpaygate.github.io/node/**

Every Bangladeshi payment gateway behind one typed API: **bKash, Nagad, SSLCommerz, Upay, ShurjoPay, aamarPay, PortPos, PayStation, UddoktaPay, Moneybag, EPS and DGePay**. Rocket, OK Wallet and IBBL/CellFin are covered through SSLCommerz, ShurjoPay and aamarPay.

Works with **Express, Next.js, NestJS, Fastify, Hono, Koa, Nuxt, SvelteKit, React Router / Remix, Astro and AdonisJS**, and runs on **Node.js 20.19+, Bun, Deno and Cloudflare Workers**. Zero runtime dependencies. ESM and CommonJS. Written in strict TypeScript.

```ts
import { createBdPayGate } from 'bdpaygate';

export const pay = createBdPayGate({
  baseUrl: 'https://shop.com.bd',
  gateways: {
    bkash: { appKey: '…', appSecret: '…', username: '…', password: '…', sandbox: true },
  },
  store, // where payments are saved: SQL, Prisma, MongoDB or your own
});

const payment = await pay.charge({
  gateway: 'bkash',
  amount: 1500,
  reference: 'ORD-1001',
  customer: { name: 'Rahim Uddin', phone: '01711000000', email: 'rahim@example.com' },
});

redirect(payment.checkoutUrl);

pay.on('payment.completed', async ({ payment }) => {
  await orders.markPaid(payment.reference, payment.gatewayTransactionId);
});
```

That is the whole integration. The package owns the callback URLs, confirms every payment with the gateway's own API before trusting it, stores it, fires an event once, and sends the customer back to your app.

## Why this one

- **No callback is trusted.** Redirects, IPNs and webhooks are claims. Every gateway confirms the payment server-to-server and checks the amount and currency before anything changes. A forged "failed" or "cancelled" can't stick either: if the gateway later confirms the money moved, the payment completes.
- **Exactly once.** Status changes are a single conditional write, so an IPN and a redirect arriving together can't both fire `payment.completed`.
- **A timeout is not a failure.** When a gateway doesn't answer, the payment stays pending and `syncPending()` settles it later. Customers who paid are never marked failed.
- **Retries are safe.** Each retry is a new attempt with a fresh gateway id; earlier attempts are kept, and if a customer pays two of them you get `payment.duplicated` instead of a second fulfilment.
- **One conformance suite for every gateway.** Forged callbacks, amount mismatches, replays, races, timeouts, late successes, malformed input, sync and refunds are tested the same way for all of them.
- **Same table as the Laravel package.** A Laravel app and a Node app can share one `bdpaygate_payments` table, and the same `.env` variable names work in both.
- **Edge-ready.** Gateways that need only `fetch` (most of them) run anywhere; Nagad, EPS, DGePay and the signature checks load `node:crypto` lazily, which Bun, Deno and Workers (with `nodejs_compat`) provide.

## Gateways

| Gateway | Status | Real sandbox run (Node) | Refunds | Sync | Docs |
|---|---|---|---|---|---|
| SSLCommerz (cards, banks, wallets incl. Rocket, OK Wallet, CellFin) | Stable | ✅ paid via Rocket, sync, partial refund | Full and partial | Yes | [sslcommerz](docs/gateways/sslcommerz.md) |
| bKash (Tokenized V2, v1.2 supported) | Stable | ✅ paid, two partial refunds, refund status, forged callbacks rejected | Full and partial (up to 10) | Yes | [bkash](docs/gateways/bkash.md) |
| ShurjoPay | Stable | ✅ paid, declined | Merchant panel | Yes | [shurjopay](docs/gateways/shurjopay.md) |
| aamarPay | Stable | ✅ paid via Nagad | Merchant panel | Yes | [aamarpay](docs/gateways/aamarpay.md) |
| PayStation | Stable | ✅ paid via bKash | Merchant panel | Yes | [paystation](docs/gateways/paystation.md) |
| UddoktaPay (self-hosted) | Stable | ✅ paid, forged invoice rejected | Merchant panel | Yes | [uddoktapay](docs/gateways/uddoktapay.md) |
| Moneybag | Stable | ✅ paid via Upay | Merchant panel | Via transaction id | [moneybag](docs/gateways/moneybag.md) |
| Nagad | Beta | Needs merchant sandbox keys | Merchant panel | Yes | [nagad](docs/gateways/nagad.md) |
| Upay | Beta | Needs merchant sandbox keys | Full | Yes | [upay](docs/gateways/upay.md) |
| PortPos (formerly PortWallet) | Beta | Needs merchant sandbox keys | Full and partial | Yes | [portpos](docs/gateways/portpos.md) |
| EPS | Experimental | Needs docs and keys | Merchant panel | Yes | [eps](docs/gateways/eps.md) |
| DGePay | Experimental | Needs docs and keys | Merchant panel | Yes | [dgepay](docs/gateways/dgepay.md) |

"Real sandbox run" means a payment was made in the gateway's own sandbox through an Express app using the published package and a SQLite store, and settled by it (2026-10-15). For every gateway with a status API, an unpaid payment was also synced and correctly stayed pending.

**Stable**: checked against the gateway's documentation and paid end to end in its sandbox. **Beta**: built from public information; not yet run against a merchant sandbox. **Experimental**: the gateway's docs are only available on request. "Merchant panel" means the gateway publishes no refund API. Test with your own sandbox account before going live.

## Install

```bash
npm install bdpaygate
# or: pnpm add bdpaygate · yarn add bdpaygate · bun add bdpaygate · deno add npm:bdpaygate
```

## Configure

```ts
// lib/payments.ts
import { createBdPayGate, gatewaysFromEnv } from 'bdpaygate';
import { sqlStore, fromPg } from 'bdpaygate/stores/sql';
import { redisCache } from 'bdpaygate/cache/redis';

export const pay = createBdPayGate({
  baseUrl: process.env.APP_URL,              // public URL the gateways call back to
  gateways: gatewaysFromEnv(process.env),     // BKASH_APP_KEY, SSLCOMMERZ_STORE_ID, … (same names as Laravel)
  default: 'sslcommerz',
  store: sqlStore({ client: fromPg(pgPool), dialect: 'postgres' }),
  cache: redisCache(redis),                   // shared tokens and locks when you run several processes
  redirects: {
    success: '/checkout/thanks',              // ?payment={id} is appended
    failed: '/checkout/failed',
    cancelled: '/cart',
    pending: '/checkout/processing',
  },
});
```

Or configure gateways in code. The object key is the gateway's name; set `driver` to run two stores of one gateway side by side:

```ts
gateways: {
  sslcommerz_retail: { driver: 'sslcommerz', storeId: '…', storePassword: '…', sandbox: false },
  sslcommerz_b2b: { driver: 'sslcommerz', storeId: '…', storePassword: '…', sandbox: false },
}
```

`sandbox` defaults to `true` for every gateway: set it to `false` explicitly for live payments.

## Mount the callback routes

Gateways call `/bdpaygate/{gateway}/{success|fail|cancel|ipn|callback}`. Mount the handler **before** any CSRF, session or auth middleware: several gateways return the customer with a cross-site POST.

**Express** (4 and 5, with or without body parsers)

```ts
import { bdpaygate } from 'bdpaygate/express';
app.use(bdpaygate(pay));
```

**Next.js App Router**: `app/bdpaygate/[gateway]/[outcome]/route.ts`

```ts
import { routeHandlers } from 'bdpaygate/next';
import { pay } from '@/lib/payments';
export const { GET, POST } = routeHandlers(pay);
```

**NestJS** (Express or Fastify platform)

```ts
import { bdpaygateMiddleware } from 'bdpaygate/nestjs';
app.use(bdpaygateMiddleware(pay)); // in main.ts, before app.listen()
```

**Fastify**

```ts
import { bdpaygate } from 'bdpaygate/fastify';
await app.register(bdpaygate, { pay });
```

**Hono** (any runtime)

```ts
import { bdpaygate } from 'bdpaygate/hono';
app.all('/bdpaygate/:gateway/:outcome', bdpaygate(pay));
```

**Koa**

```ts
import { bdpaygate } from 'bdpaygate/koa';
app.use(bdpaygate(pay));
```

**Nuxt / Nitro**: `server/routes/bdpaygate/[gateway]/[outcome].ts`

```ts
import { eventHandler } from 'bdpaygate/nuxt';
export default defineEventHandler(eventHandler(pay));
```

**SvelteKit**: `src/routes/bdpaygate/[gateway]/[outcome]/+server.ts`

```ts
import { requestHandlers } from 'bdpaygate/sveltekit';
export const { GET, POST } = requestHandlers(pay);
```

SvelteKit rejects cross-site form POSTs by default. Add your gateways' checkout origins to `kit.csrf.trustedOrigins` in `svelte.config.js` (for example `https://sandbox.sslcommerz.com` and `https://securepay.sslcommerz.com`).

**React Router 7 / Remix**: `app/routes/bdpaygate.$gateway.$outcome.ts`

```ts
import { routeModule } from 'bdpaygate/react-router';
export const { loader, action } = routeModule(pay);
```

**Astro**: `src/pages/bdpaygate/[gateway]/[outcome].ts`

```ts
import { endpoints } from 'bdpaygate/astro';
export const prerender = false;
export const { GET, POST } = endpoints(pay);
```

Astro's `security.checkOrigin` rejects cross-site form POSTs; allow your gateways' origins or disable it for these routes.

**AdonisJS 6**

```ts
import { routeHandler } from 'bdpaygate/adonis';
router.any('/bdpaygate/:gateway/:outcome', routeHandler(pay));
// config/shield.ts: csrf.exceptRoutes: (ctx) => ctx.request.url().startsWith('/bdpaygate/')
```

**Bun, Deno, Cloudflare Workers** or anything with Fetch API handlers:

```ts
Bun.serve({ fetch: pay.fetch });
Deno.serve(pay.fetch);
export default { fetch: pay.fetch }; // Workers
```

**Node's http module, Connect, Polka**: `http.createServer(nodeHandler(pay))` from `bdpaygate/node`.

## Take a payment

```ts
const payment = await pay.charge({
  gateway: 'sslcommerz',          // optional: the default gateway otherwise
  amount: 1500,                   // number or string, normalised to "1500.00"
  reference: order.number,        // your id, 1 to 64 characters
  customer: { name, phone, email, address, city, postcode, ip: req.ip }, // ShurjoPay requires the IP
  description: `Order ${order.number}`,
  meta: { orderId: order.id },    // anything JSON, stored with the payment
});

return redirect(payment.checkoutUrl);
```

Charging the same reference again creates a new attempt (a retry). A reference that is already paid is refused with `GatewayError`.

## Fulfil orders from events, never from the redirect

```ts
pay.on('payment.completed', async ({ payment }) => {
  if (payment.requiresReview) {
    // The gateway flagged it as risky (e.g. SSLCommerz risk_level=1): hold delivery.
  }
  await orders.markPaid(payment.meta?.orderId, payment.gatewayTransactionId);
});

pay.on('payment.failed', ({ payment }) => { /* payment.failureReason */ });
pay.on('payment.cancelled', ({ payment }) => { /* … */ });
pay.on('payment.duplicated', ({ payment }) => { /* a second attempt was also paid: refund one */ });
pay.on('refund.processed', ({ payment, refund }) => { /* … */ });
```

Listeners are awaited. If one throws, the callback answers with an error so the gateway retries its IPN, but the payment is already saved and the event will not fire again: make listeners idempotent, or put the work on a queue.

The customer lands on your `redirects.success` page with `?payment={id}`. Show the status there (`await pay.find(id)`); do not change order state there.

## Settle payments whose callback never arrived

```ts
// every 10 minutes: node-cron, a queue, a Vercel/Cloudflare cron, or a protected route
const { settled, errors } = await pay.syncPending();
```

`pay.sync(payment)` asks the gateway about one payment.

## Refunds

```ts
const gateway = pay.for(payment);

if (gateway.capabilities.refunds) {
  const refund = await pay.refund(payment, 500, 'Damaged item'); // omit the amount to refund everything left
  // refund.accepted, refund.pending (settles later), refund.refundId
}
```

Refund APIs exist for bKash, SSLCommerz, PortPos (partial) and Upay (full). The rest throw `UnsupportedOperationError`: refund from the gateway's merchant panel.

## Storage

| Store | Import |
|---|---|
| PostgreSQL, MySQL/MariaDB, SQLite via `pg`, `mysql2`, `better-sqlite3` or `node:sqlite` (Node 22.5+) | `sqlStore` from `bdpaygate/stores/sql` (`fromPg`, `fromMysql`, `fromSqlite`) |
| Prisma | `prismaStore(prisma.bdpaygatePayment)` from `bdpaygate/stores/prisma`, model in `node_modules/bdpaygate/prisma/bdpaygate.prisma` |
| MongoDB | `mongoStore(db.collection('bdpaygate_payments'))` from `bdpaygate/stores/mongodb` |
| Memory (tests only) | `memoryStore()` from `bdpaygate` |
| Anything else | implement the 7-method `PaymentStore` interface |

Create the SQL table with `createTableSql(dialect)` or the files in `node_modules/bdpaygate/sql/`. It is the same table the Laravel package migrates.

## Testing your app

```ts
const fake = pay.fake();            // the fake gateway becomes the default
const payment = await pay.charge({ amount: 300, reference: 'ORD-1', customer });

await pay.fetch(new Request(payment.checkoutUrl!)); // completes it like a real redirect
await fake.fail(payment);                            // or drive it from code
```

The fake gateway's callbacks refuse to run when `NODE_ENV=production`.

## IP-whitelisted gateways and proxies

Nagad and Upay only accept calls from whitelisted server IPs. Run on a fixed-IP server, or pass a `fetch` that goes through a proxy:

```ts
import { fetch, ProxyAgent } from 'undici';
const dispatcher = new ProxyAgent(process.env.FIXED_IP_PROXY!);

gateways: { nagad: { /* … */, fetch: (url, init) => fetch(url, { ...init, dispatcher }) } }
```

## Custom gateways

```ts
import { AbstractGateway } from 'bdpaygate';

class MyGateway extends AbstractGateway {
  static override readonly driver = 'mygateway';
  async charge(options) { const payment = await this.createPendingPayment(options); /* … */ }
  async handleCallback(request, outcome) { /* confirm with the API, then this.transition(…) */ }
}

pay.extend('mygateway', (config, name, ctx) => new MyGateway(config, name, ctx));
```

## AI assistants

This README and the full docs are published for AI tools at https://bdpaygate.github.io/llms.txt. The key rules for generated code: fulfil orders only in a `payment.completed` listener, never write your own callback routes, keep CSRF and sessions off `/bdpaygate/*`, and use `pay.fake()` in tests.

## Also for Laravel

The same gateways, safety rules and database table: [byteminus/laravel-bdpaygate](https://github.com/byteminus/laravel-bdpaygate).

## Security

Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## License

MIT
