-- BDPayGate payments table (postgres). Same shape as the Laravel package migration.
CREATE TABLE IF NOT EXISTS "bdpaygate_payments" (
  "id" char(26) NOT NULL PRIMARY KEY,
  "gateway" varchar(32) NOT NULL,
  "reference" varchar(64) NOT NULL,
  "gateway_reference" varchar(64) NOT NULL,
  "gateway_payment_id" varchar(128) NULL,
  "gateway_transaction_id" varchar(128) NULL,
  "amount" decimal(12, 2) NOT NULL,
  "refunded_amount" decimal(12, 2) NOT NULL DEFAULT 0,
  "currency" varchar(3) NOT NULL DEFAULT 'BDT',
  "status" varchar(24) NOT NULL,
  "requires_review" boolean NOT NULL DEFAULT false,
  "failure_reason" varchar(255) NULL,
  "description" varchar(255) NULL,
  "checkout_url" text NULL,
  "customer" json NULL,
  "meta" json NULL,
  "gateway_response" json NULL,
  "paid_at" timestamp(0) without time zone NULL,
  "created_at" timestamp(0) without time zone NULL,
  "updated_at" timestamp(0) without time zone NULL
);

CREATE INDEX IF NOT EXISTS "bdpaygate_payments_gateway_payment_id_index" ON "bdpaygate_payments" ("gateway_payment_id");

CREATE INDEX IF NOT EXISTS "bdpaygate_payments_gateway_transaction_id_index" ON "bdpaygate_payments" ("gateway_transaction_id");

CREATE INDEX IF NOT EXISTS "bdpaygate_payments_status_index" ON "bdpaygate_payments" ("status");

CREATE INDEX IF NOT EXISTS "bdpaygate_payments_gateway_reference_index" ON "bdpaygate_payments" ("gateway", "reference");

CREATE UNIQUE INDEX IF NOT EXISTS "bdpaygate_payments_gateway_gateway_reference_unique" ON "bdpaygate_payments" ("gateway", "gateway_reference");
