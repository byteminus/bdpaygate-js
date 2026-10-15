# aamarPay

Also for Laravel: https://github.com/byteminus/laravel-bdpaygate/blob/main/docs/gateways/aamarpay.md

**Status:** stable · **Driver:** `aamarpay` · **Refunds:** no API (refund from the merchant panel) · **Sync:** yes

aamarPay is a hosted checkout from a Bangladesh Bank licensed payment system operator. One integration covers:

- **Cards:** Visa, Mastercard, UnionPay, Nexus.
- **Mobile wallets:** bKash, Nagad, **Rocket (DBBL)**, Upay, Tap, **OK Wallet**, SureCash, Qcash.
- **Net banking.**

That makes it a way to accept Rocket, OK Wallet and other wallets that have no public merchant API of their own. aamarPay notes that the card option only shows for amounts of 10 BDT or more.

## Setup

```dotenv
AAMARPAY_STORE_ID=aamarpaytest
AAMARPAY_SIGNATURE_KEY=dbb74894e82415a2f7ff0ec3a97e4183
AAMARPAY_SANDBOX=true
```

These are read by `gatewaysFromEnv(process.env)`. Or configure the gateway in code:

```ts
gateways: {
  aamarpay: {
    storeId: process.env.AAMARPAY_STORE_ID,
    signatureKey: process.env.AAMARPAY_SIGNATURE_KEY,
    sandbox: true,
  },
}
```

- The values above are aamarPay's public sandbox credentials. Live credentials come from aamarPay support once your merchant account is set up.
- `sandbox` defaults to `true`. Set it to `false` for live payments.
- Hosts: `https://sandbox.aamarpay.com` (sandbox) and `https://secure.aamarpay.com` (live). Override with `baseUrl`. Sandbox credentials on the live host (or the reverse) fail with a misleading "Invalid Store ID".
- Currency must be `BDT` or `USD`.

### IPN

aamarPay can POST a JSON notification for successful payments to a URL you give their technical support during onboarding. Give them:

```
https://your-app.com/bdpaygate/aamarpay/ipn
```

The IPN is optional: `pay.syncPending()` settles payments whose return never arrived.

## How a payment is verified

1. `pay.charge()` posts to `/jsonpost.php`. The attempt's `gatewayReference` is sent as `tran_id`, your own reference in `opt_a` and the payment id in `opt_b`. The session id in the returned `payment_url` (`track=AAM…`) is aamarPay's `pg_txnid`, stored as `payment.gatewayPaymentId`.
2. aamarPay POSTs the customer's browser to `/bdpaygate/aamarpay/success` or `/fail`, with `mer_txnid`, `pg_txnid`, `status_code` and more. The cancel button returns the customer to `/bdpaygate/aamarpay/cancel?tran_id=…` with no payload. None of these are signed.
3. A callback whose `pg_txnid` differs from the stored one is rejected at once.
4. Every callback, cancel and IPN is then confirmed with the Search Transaction API (`/api/v1/trxcheck/request.php`) by `tran_id`. The answer must carry the same `mer_txnid` and `pg_txnid`. Then `status_code` decides:

   | `status_code` | Meaning | Result |
   |---|---|---|
   | `2` | Successful | Completed, once the amount and currency match and `pay_status` is "Successful" (`bank_trxid` stored as `payment.gatewayTransactionId`) |
   | `7` | Failed | Failed |
   | `3` | Expired | Failed |
   | `0` | Initiated, not paid yet | Stays pending |
   | anything else | Unknown | Stays pending |

   A fail or cancel for a payment aamarPay reports as paid completes it.
5. If aamarPay cannot be reached, or answers in plain text instead of JSON, the payment stays pending and the customer goes to your `pending` redirect. `pay.syncPending()` settles it later.

For BDT payments, `amount` is compared. For USD payments, `amount` is converted to BDT, so `amount_currency` and `currency_merchant` are compared instead.

A `risk_level` above 0 in the search result completes the payment but sets `payment.requiresReview = true`. Check it in your `payment.completed` listener before delivering.

## Refunds

aamarPay has no public refund API. Refund from the aamarPay merchant panel or through aamarPay support. `pay.refund()` throws `UnsupportedOperationError` for this gateway, and `pay.for(payment).capabilities.refunds` is `false`.

## Limits and quirks

- **A reused `tran_id` is accepted.** aamarPay then creates a second session and Search Transaction only reports the newest one. The package sends a fresh attempt id on every charge and cross-checks `pg_txnid`, so an answer about another session never completes a payment.
- **Errors come with HTTP 200.** Init errors are `{"result": false, "errors": [...]}` or `{"result": false, "message": "..."}`. Success is `"result": "true"`, a string. A wrong key on search returns plain text ("Store_id & signature key not matched"). All of these are handled.
- **Missing values are placeholders.** Fields hold `"Not-Available"` or `"Not Available"` instead of null; the package treats both as empty.
- **The signature key travels in the search query string.** If you pass a custom `fetch` that logs requests, redact it.
- **The return is a cross-site POST.** aamarPay's own troubleshooting page suggests excluding the callback from CSRF and loosening session cookies. Mount the bdpaygate handler before any CSRF, session or auth middleware and you don't need to: customers are not logged out, and your landing page receives a normal GET. SvelteKit and Astro reject cross-site form POSTs by default; allow aamarPay's checkout origin there.
- **`tran_id`** may be at most 32 characters; attempt ids are 20.
- **Customer email** is required by aamarPay; when the customer has none, a placeholder is sent.
- **The IPN's signature scheme is not documented**, so the IPN is treated like any other claim and confirmed with Search Transaction.

## Sandbox

Use the public sandbox credentials above with `AAMARPAY_SANDBOX=true`. aamarPay's own samples note that the sandbox may only offer bKash; the run below was paid with Nagad, so what it offers can vary.

This Node package was run end to end in the aamarPay sandbox on 2026-10-15:

- A payment was paid via Nagad.
- Syncing an unpaid payment left it pending.
