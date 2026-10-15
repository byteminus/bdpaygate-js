# SSLCommerz

Also for Laravel: https://github.com/byteminus/laravel-bdpaygate/blob/main/docs/gateways/sslcommerz.md

**Status:** stable · **Driver:** `sslcommerz` · **Refunds:** full and partial (asynchronous) · **Sync:** yes

SSLCommerz is a hosted checkout covering cards, internet banking and most mobile wallets. It is also how you accept wallets that have no public merchant API of their own: **Rocket (DBBL)**, **OK Wallet** and **IBBL / CellFin** are offered on the SSLCommerz checkout page.

## Setup

```dotenv
SSLCOMMERZ_STORE_ID=yourstore
SSLCOMMERZ_STORE_PASSWORD=yourstore@ssl
SSLCOMMERZ_SANDBOX=true
```

These are read by `gatewaysFromEnv(process.env)`. Or configure the gateway in code:

```ts
gateways: {
  sslcommerz: {
    storeId: process.env.SSLCOMMERZ_STORE_ID,
    storePassword: process.env.SSLCOMMERZ_STORE_PASSWORD,
    sandbox: true,
  },
}
```

`sandbox` defaults to `true`. Set it to `false` for live payments. Hosts are `https://sandbox.sslcommerz.com` (sandbox) and `https://securepay.sslcommerz.com` (live).

Sandbox stores are self-serve at <https://developer.sslcommerz.com/registration/>. Live refunds need your server's public IP registered with SSLCommerz. If your app has no fixed outbound IP, pass a `fetch` that goes through a proxy with one:

```ts
import { fetch, ProxyAgent } from 'undici';
const dispatcher = new ProxyAgent(process.env.FIXED_IP_PROXY!);

gateways: {
  sslcommerz: { /* … */, fetch: (url, init) => fetch(url, { ...init, dispatcher }) },
}
```

## Take a payment

```ts
const payment = await pay.charge({
  gateway: 'sslcommerz',
  amount: 1500,
  reference: 'ORD-1001',
  customer: { name: 'Rahim Uddin', phone: '01711000000', email: 'rahim@example.com', address: 'Dhanmondi' },
  description: 'Order ORD-1001',          // sent as product_name
  meta: { category: 'electronics' },      // meta.category and meta.profile fill product_category and product_profile
});

return redirect(payment.checkoutUrl);
```

## How a payment is verified

1. `pay.charge()` creates a session (`/gwprocess/v4/api.php`) with this attempt's `gatewayReference` as `tran_id`, the payment id in `value_a` and your own reference in `value_b`.
2. SSLCommerz posts the IPN and redirects the customer (`/bdpaygate/sslcommerz/{success|fail|cancel|ipn}`).
3. A success is accepted only if the `verify_sign` signature matches **and** the Order Validation API confirms the `val_id`, the `tran_id` and the amount. For foreign-currency payments, `currency_type` and `currency_amount` are checked rather than the converted `amount`.
4. A fail or cancel is a claim anyone could send: the package asks the Transaction Query API first, and completes the payment if SSLCommerz says it was paid.
5. `risk_level = 1` completes the payment but sets `payment.requiresReview = true`. SSLCommerz asks you to hold the service and verify the customer before delivering.

`bank_tran_id` is stored in `payment.gatewayTransactionId`.

```ts
pay.on('payment.completed', async ({ payment }) => {
  if (payment.requiresReview) {
    // risk_level=1: hold delivery until you have checked the customer.
    return;
  }
  await orders.markPaid(payment.reference, payment.gatewayTransactionId);
});
```

`pay.sync(payment)` and `pay.syncPending()` use the Transaction Query API. A payment SSLCommerz reports as paid completes; otherwise it stays as it is.

## Refunds

```ts
import type { SslCommerzGateway } from 'bdpaygate';

const result = await pay.refund(payment, 500, 'Damaged item');

result.accepted; // true: SSLCommerz initiated it
result.pending;  // true: the bank settles it later
result.refundId; // refund_ref_id

await (pay.for(payment) as SslCommerzGateway).refundStatus(result.refundId!); // "refunded", "processing" or "cancelled"
```

A `processing` answer to a refund request means that refund was already initiated, so it is not recorded a second time. An accepted refund fires `refund.processed` and updates `payment.refundedAmount`.

## Limits and quirks

- Amount must be 10.00 to 500000.00 BDT. Checked before the API call.
- `tran_id` is at most 30 characters; attempt ids are 20.
- The return to your site is a cross-site POST. Mount the bdpaygate handler **before** any CSRF, session or auth middleware so the POST is accepted and customers are not logged out. Your landing page receives a normal GET.
- SvelteKit and Astro reject cross-site form POSTs by default. Add `https://sandbox.sslcommerz.com` and `https://securepay.sslcommerz.com` to SvelteKit's `kit.csrf.trustedOrigins`, or allow them in Astro's `security.checkOrigin` handling.

## Sandbox runs

This Node package was run end to end in the SSLCommerz sandbox on 2026-10-15:

- A payment was paid via Rocket, and the cross-site POST return was handled.
- Sync of the paid payment worked.
- A partial refund was accepted asynchronously, and `refundStatus()` reported `"processing"`.
- Syncing an unpaid payment left it pending.
