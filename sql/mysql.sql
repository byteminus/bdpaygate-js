-- BDPayGate payments table (mysql). Same shape as the Laravel package migration.
CREATE TABLE IF NOT EXISTS `bdpaygate_payments` (
  `id` char(26) NOT NULL PRIMARY KEY,
  `gateway` varchar(32) NOT NULL,
  `reference` varchar(64) NOT NULL,
  `gateway_reference` varchar(64) NOT NULL,
  `gateway_payment_id` varchar(128) NULL,
  `gateway_transaction_id` varchar(128) NULL,
  `amount` decimal(12, 2) NOT NULL,
  `refunded_amount` decimal(12, 2) NOT NULL DEFAULT 0,
  `currency` varchar(3) NOT NULL DEFAULT 'BDT',
  `status` varchar(24) NOT NULL,
  `requires_review` tinyint(1) NOT NULL DEFAULT 0,
  `failure_reason` varchar(255) NULL,
  `description` varchar(255) NULL,
  `checkout_url` text NULL,
  `customer` json NULL,
  `meta` json NULL,
  `gateway_response` json NULL,
  `paid_at` timestamp NULL,
  `created_at` timestamp NULL,
  `updated_at` timestamp NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `bdpaygate_payments_gateway_payment_id_index` ON `bdpaygate_payments` (`gateway_payment_id`);

CREATE INDEX `bdpaygate_payments_gateway_transaction_id_index` ON `bdpaygate_payments` (`gateway_transaction_id`);

CREATE INDEX `bdpaygate_payments_status_index` ON `bdpaygate_payments` (`status`);

CREATE INDEX `bdpaygate_payments_gateway_reference_index` ON `bdpaygate_payments` (`gateway`, `reference`);

CREATE UNIQUE INDEX `bdpaygate_payments_gateway_gateway_reference_unique` ON `bdpaygate_payments` (`gateway`, `gateway_reference`);
