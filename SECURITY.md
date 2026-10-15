# Security policy

This package moves money, so security reports get priority.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's [private vulnerability reporting](https://github.com/byteminus/bdpaygate-js/security/advisories/new).

Include the gateway involved, the steps to reproduce, and the impact you see (for example "a forged callback marks an unpaid order as paid"). You will get an answer within 72 hours, and a fix or a plan within 14 days for confirmed issues. Credit is given in the advisory unless you ask otherwise.

## Supported versions

The latest minor release receives security fixes.

## What the package guarantees

- No payment changes state from what a callback claims: the gateway's own API is asked first, and the amount and currency must match.
- A payment completes at most once, and `payment.completed` fires at most once.
- A gateway that does not answer never causes a payment to be marked failed.

A way to break any of these is a vulnerability.
