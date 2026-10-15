# DGePay

Also for Laravel: https://github.com/byteminus/laravel-bdpaygate/blob/main/docs/gateways/dgepay.md

**Status:** experimental · **Driver:** `dgepay` · **Refunds:** no (use the DGePay merchant panel) · **Sync:** yes

DGePay is a Bangladesh Bank-licensed payment service operator. Its hosted checkout covers bKash, Nagad and other mobile wallets.

> **Experimental.** DGePay's API guide is only given to merchants. This driver is built from the provider's published SDK and has not been run against DGePay's UAT, in either the Laravel or the Node package. Request the integration guide and UAT credentials from DGePay, and verify the driver against UAT before going live.

## Setup

```dotenv
DGEPAY_CLIENT_ID=
DGEPAY_CLIENT_SECRET=
DGEPAY_API_KEY=
DGEPAY_SANDBOX=true
```

These are read by `gatewaysFromEnv(process.env)`. Or configure the gateway in code:

```ts
gateways: {
  dgepay: {
    clientId: process.env.DGEPAY_CLIENT_ID,
    clientSecret: process.env.DGEPAY_CLIENT_SECRET,
    apiKey: process.env.DGEPAY_API_KEY,
    sandbox: true, // true = UAT

    // Optional:
    // baseUrl: 'https://api-dev.dgepay.net/dipon/v3', // DGePay's DEV environment
    // failedStatusCodes: ['4'], // status codes treated as a definite failure
    // tokenTtl: 300,            // seconds, if the JWT has no exp claim
  },
}
```

The optional settings have no environment variables; set them in code. `sandbox` defaults to `true`. Set it to `false` for live payments.

| Environment | API base |
|---|---|
| UAT (`sandbox: true`) | `https://api-uat.dgepay.net/dipon/v3` |
| Live | `https://apiv2.dgepay.net/dipon/v3` |
| DEV (set as `baseUrl`) | `https://api-dev.dgepay.net/dipon/v3` |

## Capabilities

| | |
|---|---|
| Charge (hosted checkout) | yes |
| Callback verification | status API, every time |
| Sync (`pay.sync`, `pay.syncPending`) | yes |
| Refunds | no. No refund endpoint has been published. `pay.refund()` throws `UnsupportedOperationError`. |
| Server-to-server notification | none known. Run `pay.syncPending()` on a schedule. |
| Currency | BDT only |

## How a payment is verified

1. **Authenticate.** `POST /payment_gateway/authenticate` with `Authorization: Basic base64(clientId:clientSecret)`, plus the same two values in the JSON body. The JWT that comes back is cached until its `exp` claim, less a minute, in the `cache` you pass to `createBdPayGate`. If DGePay answers 401, the driver fetches a new token and retries once.
2. **Initiate.** `POST /payment_gateway/initiate_payment` sends `amount`, `unique_txn_id`, `redirect_url` and `note` (your description, or your reference). It also sends `customer_token` and `payment_method` (null unless you pass `meta.paymentMethod`), and `payee_information` when `customer.phone` is a Bangladeshi mobile number.
   - `unique_txn_id` is this attempt's `gatewayReference`, new for every attempt.
   - The body is **encrypted**: JSON with sorted keys → AES-128-ECB (PKCS#7) → base64. The key is the client secret, padded with `0` or cut to 16 bytes.
   - The `Signature` header is base64(HMAC-SHA256(api key, canonical)). *canonical* is the same sorted JSON with `{ } " : ,` and spaces removed, so `{"amount":150.0,"note":"Order 1"}` becomes `amount150.0noteOrder1`. Nulls appear as `null`, and amounts as `150.0` or `150.5`.
   - The customer is redirected to `payment.checkoutUrl` (`data.webview_url`).
3. **Return.** DGePay returns the customer to `/bdpaygate/dgepay/callback?data=<encrypted JSON>`.
   - Query-string parsing turns `+` into spaces, so the driver restores the `+` signs, then decrypts. A `data` value that does not decrypt with your client secret is rejected.
   - Only `unique_txn_id` is used from the decrypted payload, to find the payment. Its `status_code` is ignored.
4. **Confirm.** `POST /payment_gateway/check_transaction_status` (encrypted and signed in the same way) gives the result:

   | `data.status_code` | Result |
   |---|---|
   | `3` | Completed, if `data.amount` matches |
   | `8` | Cancelled |
   | `4` (`failedStatusCodes`) | Failed |
   | anything else, or no `data` | stays pending |

   On completion, `txn_id` goes into `payment.gatewayPaymentId` and `txn_number` into `payment.gatewayTransactionId`. An HTTP 5xx answer is treated as "DGePay unavailable": the payment stays pending.

## Limits and quirks

- **Errors come back with HTTP 200.** The body has `"success": 0` and an `error` list. The driver reads the body.
- **Plain JSON is rejected.** DGePay answers it with `REQUESTED_PARAMETERS_ARE_MISMATCHED`. Every call after authentication must be encrypted and signed.
- **AES-ECB is DGePay's choice.** It is a weak mode, used here only because the API requires it. Keep the client secret and API key out of version control.
- **Signature formatting is strict.** Numeric-looking strings (phone numbers, `+88`) are signed as given. Only real numbers are rendered as JSON numbers.
- **`node:crypto`.** The encryption and signature use `node:crypto`, loaded lazily. It runs on Node, Bun, Deno and Cloudflare Workers with `nodejs_compat`.

## Unverified

These points come from DGePay's published SDK, not from the request-only API guide:

- The full status-code table. `3` (success) and `8` (cancelled) are documented. `4` comes from an SDK sample whose message is "TRANSACTION FAILED". Every other code is treated as pending.
- How amounts with two decimal places (`150.25`) appear in the signature. The driver uses the JSON form, `150.25`. One unofficial client rounds to one decimal place instead.
- Whether `authenticate` also needs the body credentials. The SDK sends Basic auth only. This driver sends both.
- Whether `payee_information` and `payment_method` are validated.
- How long a token lasts, beyond the JWT `exp` claim.
- Whether DGePay has a webhook/IPN or a refund API. None is known.
- How to get UAT or DEV credentials.
