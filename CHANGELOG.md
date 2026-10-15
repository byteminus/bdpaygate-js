# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## 0.1.0

First release.

- Twelve gateways behind one API: bKash (Tokenized V2 and v1.2), SSLCommerz, ShurjoPay, aamarPay, PayStation, UddoktaPay, Moneybag (stable); Nagad, Upay, PortPos (beta); EPS, DGePay (experimental).
- Verified callbacks: every redirect, IPN and webhook is confirmed with the gateway's API, including amount and currency, before the payment changes state.
- Exactly-once transitions through a conditional store write; `payment.completed` fires once even when an IPN and a redirect race.
- Timeouts leave payments pending; `syncPending()` settles them.
- Retries create new attempts with fresh gateway references; a second paid attempt fires `payment.duplicated`.
- Refunds for bKash (partial, up to 10), SSLCommerz (partial), PortPos (partial) and Upay (full).
- Adapters for Express, Fastify, Koa, NestJS, Next.js (App and Pages Router), Hono, Nuxt/Nitro (h3 v1 and v2), SvelteKit, React Router 7 / Remix, Astro, AdonisJS, Node's http module, and Fetch API runtimes (Bun, Deno, Cloudflare Workers).
- Stores for PostgreSQL, MySQL/MariaDB and SQLite (`pg`, `mysql2`, `better-sqlite3`, `node:sqlite`), Prisma and MongoDB, sharing the Laravel package's table. Redis caches for node-redis and ioredis.
- `gatewaysFromEnv()` reads the same environment variables as the Laravel package.
- `pay.fake()` for tests. ESM and CommonJS builds, strict TypeScript types, no runtime dependencies.
