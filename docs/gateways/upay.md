# Upay

Also for Laravel: https://github.com/byteminus/laravel-bdpaygate/blob/main/docs/gateways/upay.md

**Status:** beta · **Driver:** `upay` · **Refunds:** full amount only, may be asynchronous · **Sync:** yes

> **Beta.** This driver was built from public information and has not yet been verified against an Upay merchant sandbox, in either the Laravel or the Node package. Get the official API document from Upay during onboarding and check the behaviour described here against it. Please report anything that differs.

Upay is the mobile financial service of UCB Fintech. Its merchant payment gateway is a hosted checkout where the customer pays with their Upay wallet. Access is not self-serve: Upay issues the API document and credentials during merchant onboarding.

## Setup

```dotenv
UPAY_MERCHANT_ID=
UPAY_MERCHANT_KEY=
UPAY_MERCHANT_CODE=
UPAY_MERCHANT_NAME=
UPAY_MERCHANT_MOBILE=
UPAY_MERCHANT_CITY=Dhaka
UPAY_MERCHANT_CATEGORY_CODE=
UPAY_SANDBOX=true
UPAY_BASE_URL=
```

These are read by `gatewaysFromEnv(process.env)`. Or configure the gateway in code:

```ts
gateways: {
  upay: {
    merchantId: process.env.UPAY_MERCHANT_ID,
    merchantKey: process.env.UPAY_MERCHANT_KEY,
    merchantCode: process.env.UPAY_MERCHANT_CODE,
    merchantName: process.env.UPAY_MERCHANT_NAME,
    merchantMobile: process.env.UPAY_MERCHANT_MOBILE,
    merchantCity: 'Dhaka',
    merchantCategoryCode: process.env.UPAY_MERCHANT_CATEGORY_CODE,
    sandbox: true,
    baseUrl: process.env.UPAY_BASE_URL,
    // merchantCountryCode: 'BD',
    // tokenTtl: 600,          // seconds to cache the auth token
    // fetch: …,               // a proxied fetch for a fixed, whitelisted egress IP (see below)
  },
}
```

- All of these come from Upay. The merchant code and category code may arrive only with the live credentials. Every merchant field is sent with each payment, and `merchantId`, `merchantKey`, `merchantName`, `merchantCode`, `merchantCategoryCode` and `merchantMobile` are required: `pay.charge()` throws `ConfigurationError` when one is missing.
- `sandbox` defaults to `true`. Set it to `false` for live payments.
- Hosts: `https://uat-pg.upay.systems` (UAT) and `https://pg.upaysystem.com` (live). The live host is not stated in Upay's document; confirm it with Upay and override with `baseUrl` if it differs.
- There is no `UPAY_PROXY` variable in the Node package: pass a `fetch` instead (see [IP whitelisting](#limits-and-quirks)).
- Currency must be `BDT`.

## How a payment is verified

1. The driver gets a token from `POST /payment/merchant-auth/` with your merchant id and key, and sends it as `Authorization: UPAY {token}` on every later call. Upay does not document an expiry, so the token is cached for `tokenTtl` seconds (10 minutes by default) in the `cache` you pass to `createBdPayGate`. A 401 or 403 drops the cached token and retries once with a fresh one.
2. `pay.charge()` calls `POST /payment/merchant-payment-init/`. The attempt's `gatewayReference` is sent as **both** `txn_id` and `invoice_id`, because the redirect only carries `invoice_id` and the status API only takes `txn_id`. Your own reference goes in `additional_info.reference` (and your `description`, if any, in `additional_info.description`). Upay's `trx_id` is stored as `payment.gatewayPaymentId`, and the customer is sent to `payment.checkoutUrl` (`gateway_url`).
3. Upay redirects the customer's browser to `/bdpaygate/upay/callback` with `status` and `invoice_id`. **This is not signed.** The package only uses it to find the payment.
4. The package calls `GET /payment/single-payment-status/{txn_id}/`. The answer must carry the same `txn_id`. Then `status` decides:

   | `status` | Result |
   |---|---|
   | `success` | Completed, once the amount matches (`trx_id` stored as `payment.gatewayTransactionId`) |
   | `failed`, `expired` | Failed |
   | `cancelled` | Cancelled |
   | `pending`, anything else | Stays pending |
   | Not found (`PNF4012`) or an error | Stays pending |

   A failure redirect for a payment Upay reports as paid completes it. Failed and cancelled payments get a `failureReason` such as `"Upay: expired"`.
5. If Upay cannot be reached, the payment stays pending and the customer goes to your `pending` redirect. `pay.syncPending()` settles it later.

## Refunds

```ts
const result = await pay.refund(payment);   // full amount only

result.accepted; // Upay took it
result.pending;  // true when Upay answered "under process"
result.message;  // Upay's English message
```

- Refunds go through Upay's bulk refund endpoint (`POST /payment/bulk/refund/`) with one entry: the payment's `txn_id` and the amount as a string.
- A `txn_id` in the answer's success list is an accepted refund.
- A failure entry reading "Your request is under process" means Upay took the request and will settle it later. It is reported as accepted with `pending: true`, and counts against the refundable amount. Upay documents no refund status endpoint, so confirm the outcome in the merchant panel.
- Any other failure entry (for example "Invalid amount" or "already refunded") is reported as not accepted, with Upay's English message in `result.message`.
- **Full refunds only.** The API takes a per-transaction amount, but partial refunds are not publicly confirmed, so `pay.refund(payment, '50.00')` throws `UnsupportedOperationError`. `pay.for(payment).capabilities.refunds` is `'full'`. Make partial refunds from the merchant panel.
- If the refund call times out, nothing is recorded. Check the merchant panel before you retry.
- An accepted refund fires `refund.processed` and updates `payment.refundedAmount`.

## Limits and quirks

- **IP whitelisting.** Upay's live gateway is IPv4 only and expects calls from whitelisted server IPs. Run on a fixed-IP server, or pass a `fetch` that goes through a proxy with a fixed, whitelisted IPv4 egress address:

  ```ts
  import { fetch, ProxyAgent } from 'undici';
  const dispatcher = new ProxyAgent(process.env.FIXED_IP_PROXY!);

  gateways: { upay: { /* … */, fetch: (url, init) => fetch(url, { ...init, dispatcher }) } }
  ```

  Serverless and edge platforms usually have no fixed outbound IP, so they need the proxy.
- **Trailing slashes.** Every Upay path ends in `/`. Without it, the server may redirect and drop the POST body.
- **The redirect URL format.** Upay may append `&status=…&invoice_id=…` to the redirect URL instead of starting a query string. The package's redirect URL already carries a query parameter (`?txn=<gatewayReference>`), so the appended values still parse, and the callback also handles a second `?`. If `invoice_id` is missing, `txn` identifies the payment. Either way, the status API decides.
- **Duplicate `txn_id`s are rejected** (`DTP4003`). Each attempt gets a fresh 20-character id, so a retry never reuses one.
- **Bangladesh time.** The init `date` is today's date in Asia/Dhaka, whatever your server timezone is.
- **The token carries your merchant key** in readable form. The driver never logs auth responses. If you pass a custom `fetch` that logs requests, keep it away from the token too.
- **Amounts** come back as JSON numbers (`150.0`) and are compared numerically.
