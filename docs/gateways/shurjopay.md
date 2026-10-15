# ShurjoPay

Also for Laravel: https://github.com/byteminus/laravel-bdpaygate/blob/main/docs/gateways/shurjopay.md

**Status:** stable · **Driver:** `shurjopay` · **Refunds:** no API (refund from the merchant panel) · **Sync:** yes

ShurjoPay is a hosted checkout from a Bangladesh Bank licensed payment system operator. One integration covers:

- **Cards:** Visa, Mastercard, American Express, UnionPay, Nexus Pay, Diners.
- **Mobile wallets:** bKash, Nagad, **Rocket (DBBL)**, Upay, Tap, mCash, Pathao Pay, Pocket, Meghna Pay, CellFin and others ShurjoPay lists on its checkout.
- **EMI** on supported cards.

That makes it a way to accept Rocket and the smaller wallets that have no public merchant API of their own. The verification response's `method` field (stored in `payment.gatewayResponse`) tells you which one the customer used.

## Setup

```dotenv
SHURJOPAY_USERNAME=sp_sandbox
SHURJOPAY_PASSWORD=pyyk97hu&6u6
SHURJOPAY_PREFIX=sp
SHURJOPAY_SANDBOX=true
```

These are read by `gatewaysFromEnv(process.env)`. Or configure the gateway in code:

```ts
gateways: {
  shurjopay: {
    username: process.env.SHURJOPAY_USERNAME,
    password: process.env.SHURJOPAY_PASSWORD,
    prefix: process.env.SHURJOPAY_PREFIX,
    sandbox: true,
  },
}
```

- `prefix` is the short order prefix (at most 5 characters) agreed with ShurjoPay. ShurjoPay builds its own order id (`sp_order_id`) from it.
- The values above are ShurjoPay's public sandbox credentials. Live credentials come from ShurjoPay during merchant onboarding. Sandbox tokens do not work on live.
- `sandbox` defaults to `true`. Set it to `false` for live payments.
- Hosts: `https://sandbox.shurjopayment.com` (sandbox) and `https://engine.shurjopayment.com` (live). Override with `baseUrl` (host only, without `/api`).
- Currency must be `BDT` or `USD`.

### Client IP

ShurjoPay requires the customer's IP address (`client_ip`), and the sandbox rejects a payment without one. Pass the IP of the request that started checkout as `customer.ip`:

```ts
const payment = await pay.charge({
  gateway: 'shurjopay',
  amount: 1500,
  reference: 'ORD-1001',
  customer: { name: 'Rahim Uddin', phone: '01711000000', ip: clientIp },
});
```

If you give none, the driver sends `127.0.0.1` so the request is not rejected. Behind a proxy or load balancer, take the IP from the header your proxy sets (for example `X-Forwarded-For`), not the socket address.

### IPN

ShurjoPay can also notify a server URL about payments whose browser return was lost. Ask ShurjoPay support to register:

```
https://your-app.com/bdpaygate/shurjopay/ipn
```

The IPN is optional: `pay.syncPending()` settles payments whose return never arrived.

## How a payment is verified

1. `pay.charge()` gets an access token (`/api/get_token`), then creates the payment (`/api/secret-pay`). The attempt's `gatewayReference` is sent as `order_id`, your own reference goes in `value1` and the payment id in `value2`. ShurjoPay's `sp_order_id` is stored as `payment.gatewayPaymentId`.
2. ShurjoPay sends the customer back to `/bdpaygate/shurjopay/success` or `/cancel` with only `?order_id=<sp_order_id>`. The return carries no status and no signature. The IPN carries the same single field.
3. Whatever the URL, the package calls the Verification API (`/api/verification`) with the `sp_order_id`. It checks that the answer is about the same `sp_order_id` and `customer_order_id`, and that the amount and currency match. Only then does `sp_code` decide:

   | `sp_code` | Meaning | Result |
   |---|---|---|
   | `1000` | Paid | Completed (`bank_trx_id` stored as `payment.gatewayTransactionId`) |
   | `1001` | Declined by the issuing bank | Failed (`payment.failureReason`, e.g. `"1001 Failed"`) |
   | `1002` | Cancelled by the customer | Cancelled |
   | `1068` | Initiated, not paid yet (undocumented) | Stays pending |
   | anything else | Unknown | Stays pending |

   A cancel return for a payment ShurjoPay reports as paid completes it. A cancel return for a payment that is still "initiated" leaves it pending, because anyone can open that URL.
4. If ShurjoPay cannot be reached, the payment stays pending and the customer goes to your `pending` redirect. `pay.syncPending()` settles it later.

These fire `payment.completed`, `payment.failed` or `payment.cancelled` once.

## Refunds

ShurjoPay has no public refund API. Refund from the ShurjoPay merchant panel or through ShurjoPay support. `pay.refund()` throws `UnsupportedOperationError` for this gateway, and `pay.for(payment).capabilities.refunds` is `false`.

## Limits and quirks

- **Tokens last 15 minutes.** The docs sample says `expires_in: 3600` "milliseconds", but the API returns `900` seconds. The token is cached for at most 14 minutes, together with the `store_id` the token call returns. It is shared across processes when you pass a shared `cache` (for example `redisCache(redis)`) to `createBdPayGate`.
- **`1064 Unauthorized`** (undocumented) means the token expired or was revoked. The package fetches a new token and retries once. If ShurjoPay still refuses, the call fails with `GatewayUnavailableError` and the payment stays pending: check the username and password.
- **Errors come with HTTP 200.** Verification answers are a one-element JSON array, but errors are sometimes a bare object, and `secret-pay` validation errors are an object of field messages. All of these are handled.
- **`sp_code`** is a string in practice and an integer in the docs; both are accepted.
- **Verification only knows ShurjoPay's id.** Asking with your own `order_id` returns `1011`. Callbacks are therefore looked up by `gatewayPaymentId`, and a payment whose `secret-pay` call timed out before returning an `sp_order_id` cannot be synced.
- **Amounts come back with four decimals** (`"150.0000"`). They are compared after rounding to two.
- **`value4` is overwritten by ShurjoPay** in sandbox, so the package does not use it.
- **Customer email** is optional at ShurjoPay; when the customer has none, a placeholder is sent.
- **Return URLs are GET requests**, and IPNs are POSTs. The package's callback routes accept both. Keep CSRF and session middleware off `/bdpaygate/*`.

## Sandbox

Use the public sandbox credentials above with `SHURJOPAY_SANDBOX=true`. The sandbox checkout lives at `sandbox.securepay.shurjopayment.com`.

This Node package was run end to end in the ShurjoPay sandbox on 2026-10-15:

- A payment was paid.
- A declined payment was marked failed, with `failureReason` `"1001 Failed"`.
- Syncing an unpaid payment left it pending.
- The sandbox rejects payments without `client_ip`, which is why the driver always sends one.
