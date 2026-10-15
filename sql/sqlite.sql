-- BDPayGate payments table (sqlite). Same shape as the Laravel package migration.
CREATE TABLE IF NOT EXISTS "bdpaygate_payments" (
  "id" varchar NOT NULL PRIMARY KEY,
  "gateway" varchar NOT NULL,
  "reference" varchar NOT NULL,
  "gateway_reference" varchar NOT NULL,
  "gateway_payment_id" varchar NULL,
  "gateway_transaction_id" varchar NULL,
  "amount" numeric NOT NULL,
  "refunded_amount" numeric NOT NULL DEFAULT 0,
  "currency" varchar NOT NULL DEFAULT 'BDT',
  "status" varchar NOT NULL,
  "requires_review" integer NOT NULL DEFAULT 0,
  "failure_reason" varchar NULL,
  "description" varchar NULL,
  "checkout_url" text NULL,
  "customer" text NULL,
  "meta" text NULL,
  "gateway_response" text NULL,
  "paid_at" datetime NULL,
  "created_at" datetime NULL,
  "updated_at" datetime NULL
);

CREATE INDEX IF NOT EXISTS "bdpaygate_payments_gateway_payment_id_index" ON "bdpaygate_payments" ("gateway_payment_id");

CREATE INDEX IF NOT EXISTS "bdpaygate_payments_gateway_transaction_id_index" ON "bdpaygate_payments" ("gateway_transaction_id");

CREATE INDEX IF NOT EXISTS "bdpaygate_payments_status_index" ON "bdpaygate_payments" ("status");

CREATE INDEX IF NOT EXISTS "bdpaygate_payments_gateway_reference_index" ON "bdpaygate_payments" ("gateway", "reference");

CREATE UNIQUE INDEX IF NOT EXISTS "bdpaygate_payments_gateway_gateway_reference_unique" ON "bdpaygate_payments" ("gateway", "gateway_reference");
