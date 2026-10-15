# EPS (Easy Payment System)

Also for Laravel: https://github.com/byteminus/laravel-bdpaygate/blob/main/docs/gateways/eps.md

**Status:** experimental · **Driver:** `eps` · **Refunds:** no (use the EPS merchant panel) · **Sync:** yes

EPS is a hosted checkout covering cards (Visa, Mastercard, Amex), internet banking and most wallets (bKash, Nagad, Rocket, OK Wallet and others).

> **Experimental.** EPS does not publish its API reference. This driver is built from the provider's published SDKs and has not been run against an EPS sandbox, in either the Laravel or the Node package. Request the integration guide and sandbox credentials from EPS (integration@eps.com.bd), and verify the driver against the sandbox before going live.

## Setup

```dotenv
EPS_USERNAME=
EPS_PASSWORD=
EPS_HASH_KEY=
EPS_MERCHANT_ID=
EPS_STORE_ID=
EPS_SANDBOX=true
```

These are read by `gatewaysFromEnv(process.env)`. Or configure the gateway in code:

```ts
gateways: {
  eps: {
    username: process.env.EPS_USERNAME,
    password: process.env.EPS_PASSWORD,
    hashKey: process.env.EPS_HASH_KEY,
    merchantId: process.env.EPS_MERCHANT_ID,
    storeId: process.env.EPS_STORE_ID,
    sandbox: true,

    // Optional:
    // deviceTypeId: '…',       // sent only if set
    // statusAttempts: 3,       // status API tries when EPS answers 404
    // statusRetryDelay: 1500,  // milliseconds between those tries
    // ipnWindow: 120,          // minutes of pending payments an IPN re-checks
    // ipnSweepLimit: 10,       // at most this many per IPN
    // tokenTtl: 300,           // seconds, if EPS gives no token expiry
  },
}
```

The optional settings have no environment variables; set them in code. `sandbox` defaults to `true`. Set it to `false` for live payments.

All five credentials come from EPS after merchant registration and KYC. There are no public test credentials.

| Environment | API host |
|---|---|
| Sandbox | `https://sandboxpgapi.eps.com.bd` |
| Live | `https://pgapi.eps.com.bd` |

## Capabilities

| | |
|---|---|
| Charge (hosted checkout) | yes |
| Callback verification | status API, every time |
| Sync (`pay.sync`, `pay.syncPending`) | yes |
| Refunds | no. EPS's refund policy says refunds can be requested "through the API or by email", but no refund endpoint has been published. `pay.refund()` throws `UnsupportedOperationError`. |
| Currency | BDT only |

## Take a payment

```ts
const payment = await pay.charge({
  gateway: 'eps',
  amount: 1500,
  reference: 'ORD-1001',
  customer: { name: 'Rahim Uddin', phone: '01711000000', email: 'rahim@example.com', ip: clientIp },
  meta: { state: 'Dhaka', postcode: '1205' }, // optional: CustomerState and CustomerPostcode
});

return redirect(payment.checkoutUrl);
```

`customer.ip` is sent as `ipAddress` (`0.0.0.0` when you give none). `meta.category` and `meta.profile` fill `ProductCategory` and `ProductProfile`. `CustomerPostcode` comes from `meta.postcode` (default `1000`), not from `customer.postcode`.

## How a payment is verified

1. `pay.charge()` fetches a token (`/v1/Auth/GetToken`), caches it until it expires, and calls `/v1/EPSEngine/InitializeEPS`.
   - `merchantTransactionId` is this attempt's `gatewayReference`: 20 digits, new for every attempt.
   - `CustomerOrderId` is your reference plus a per-attempt suffix.
   - `ValueA` and `ValueB` carry the payment id and your reference.
   - EPS's `TransactionId` is stored in `payment.gatewayPaymentId`.
2. Every request carries `x-hash` = base64(HMAC-SHA512(hash key, value)). The signed value depends on the endpoint:
   - GetToken signs the username.
   - InitializeEPS signs the merchant transaction id.
   - CheckMerchantTransactionStatus signs the merchant transaction id.
3. EPS returns the customer with a GET to `/bdpaygate/eps/{success|fail|cancel}`, adding `?Status=…&MerchantTransactionId=…&EPSTransactionId=…`. The redirect is not signed, so the package ignores `Status` and calls `CheckMerchantTransactionStatus` to get the result.
4. A payment is completed only when the status API says it was paid **and** `TotalAmount` matches. EPS's transaction id goes into `payment.gatewayPaymentId` and `payment.gatewayTransactionId`.
5. If the status API says failed or cancelled, the payment is marked that way. If it says pending, gives an unknown status, or has no answer, the payment stays pending. `pay.syncPending()` settles it later.

### The 404 after payment

Right after a payment, EPS's status API can answer 404 for a short time. The driver retries 404s (`statusAttempts`, `statusRetryDelay`). If it still gets 404 after that, the payment stays **pending**. It is never marked failed because of a 404. An HTTP 5xx answer is treated as "EPS unavailable": the payment stays pending too.

### IPN

EPS's IPN body is encrypted with AES-256-CBC (`{"Data": "<iv>:<ciphertext>"}`), and the key format is not documented, so the driver does not decrypt it. It treats any POST to `/bdpaygate/eps/ipn` as a signal:

- If the body names the merchant transaction id in plain text, that payment is checked.
- Otherwise the driver checks this gateway's pending payments from the last `ipnWindow` minutes, newest first, up to `ipnSweepLimit` of them, against the status API. Because the IPN URL is public and unauthenticated, this sweep runs at most once a minute and skips the 404 retries. It uses the `cache` you pass to `createBdPayGate`, so with several processes use a shared cache (for example `redisCache(redis)`) for the limit to hold across them.
- With no recent pending EPS payment, the IPN is rejected with HTTP 400.

An IPN body is never treated as proof of payment. Ask EPS support to register `https://your-app/bdpaygate/eps/ipn` as your IPN URL.

## Limits and quirks

- **Errors come back with HTTP 200.** For example, a bad login gives `token: null` and an `errorMessage`. The driver reads the body, not the status code.
- **Mixed key casing and literal `null`s.** Requests mix camelCase and PascalCase. Responses are read case-insensitively, and `null` or `""` counts as missing.
- **Escaped return parameters.** EPS can HTML-escape the separators in the return URL (`&amp;MerchantTransactionId=`). The driver strips the `amp;` prefix. The callback URLs it gives EPS have no query string.
- **The status API is GET.** POST was reported to return 405.
- **Rate limit.** EPS was seen to send `X-Rate-Limit-Limit: 40`. The time window is not known. Keep `ipnSweepLimit` small.
- **Origin/IP checks.** EPS may only accept calls from your registered domain or IP. If your servers have no fixed IP, pass a `fetch` that goes through a proxy with one:

  ```ts
  import { fetch, ProxyAgent } from 'undici';
  const dispatcher = new ProxyAgent(process.env.FIXED_IP_PROXY!);

  gateways: { eps: { /* … */, fetch: (url, init) => fetch(url, { ...init, dispatcher }) } }
  ```

- **`node:crypto`.** The HMAC and the 20-digit ids use `node:crypto`, loaded lazily. It runs on Node, Bun, Deno and Cloudflare Workers with `nodejs_compat`.

## Unverified

These points come from EPS's SDKs and a production write-up, not from an official specification:

- The status vocabulary. The driver accepts `Success`, `Successful`, `Succeeded`, `Completed`, `Complete` and `Paid` as paid; `Failed`, `Failure`, `Fail`, `Declined` and `Rejected` as failed; `Cancel`, `Canceled`, `Cancelled`, `Aborted` and `Abort` as cancelled. Anything else is pending.
- Whether `deviceTypeId` and `transactionDate` are required. `transactionDate` is always sent; `deviceTypeId` only when configured.
- Limits on the format and length of `merchantTransactionId`. EPS's SDKs use digits only, so the driver does too.
- How long a token lasts. The driver uses `expireDate` or the JWT `exp` claim, and falls back to `tokenTtl`.
- How IPNs are registered, how often they are retried, and what reply EPS expects. EPS's IPN page asks for `{"status":"OK"}`, but the package answers `{"ok":true,...}`.
- Whether there is a refund API.
