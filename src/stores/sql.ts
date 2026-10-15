/**
 * PostgreSQL, MySQL/MariaDB and SQLite, through the driver you already use.
 * The table is the same as the Laravel package's, so a Laravel app and a
 * Node app can share it.
 *
 *     import pg from 'pg';
 *     import { sqlStore, fromPg } from 'bdpaygate/stores/sql';
 *     const store = sqlStore({ client: fromPg(new pg.Pool()), dialect: 'postgres' });
 *
 * Create the table with the SQL in node_modules/bdpaygate/sql/, or with
 * createTableSql(dialect).
 */
import { isPaid, toFixed2 } from '../core/payment.js';
import type { PaymentStore, PendingQuery } from '../core/store.js';
import { PAID_STATUSES, type Payment, type PaymentStatus } from '../core/types.js';

export type Dialect = 'postgres' | 'mysql' | 'sqlite';

export interface SqlResult {
  rows: Record<string, unknown>[];
  /** Rows changed by an INSERT/UPDATE. */
  rowCount: number;
}

/** Runs one parameterised statement. Placeholders are $1.. for postgres, ? otherwise. */
export interface SqlClient {
  query(sql: string, params: unknown[]): Promise<SqlResult>;
}

export interface SqlStoreOptions {
  client: SqlClient;
  dialect: Dialect;
  /** Default "bdpaygate_payments". */
  table?: string;
}

const COLUMNS = [
  'id',
  'gateway',
  'reference',
  'gateway_reference',
  'gateway_payment_id',
  'gateway_transaction_id',
  'amount',
  'refunded_amount',
  'currency',
  'status',
  'requires_review',
  'failure_reason',
  'description',
  'checkout_url',
  'customer',
  'meta',
  'gateway_response',
  'paid_at',
  'created_at',
  'updated_at',
] as const;

const TIMESTAMPS = new Set(['paid_at', 'created_at', 'updated_at']);

/** "2026-10-15 08:30:00" in UTC: the format Laravel writes. */
function timestamp(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 19).replace('T', ' ') : null;
}

function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  const text = String(value);

  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  if (value instanceof Uint8Array) {
    return parseJson(new TextDecoder().decode(value), fallback);
  }

  return value as T;
}

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export function rowToPayment(row: Record<string, unknown>): Payment {
  return {
    id: String(row.id),
    gateway: String(row.gateway),
    reference: String(row.reference),
    gatewayReference: String(row.gateway_reference),
    gatewayPaymentId: text(row.gateway_payment_id),
    gatewayTransactionId: text(row.gateway_transaction_id),
    amount: toFixed2(Number(row.amount)),
    refundedAmount: toFixed2(Number(row.refunded_amount ?? 0)),
    currency: String(row.currency ?? 'BDT'),
    status: String(row.status) as PaymentStatus,
    requiresReview:
      row.requires_review === true || Number(row.requires_review) === 1 || row.requires_review === 't',
    failureReason: text(row.failure_reason),
    description: text(row.description),
    checkoutUrl: text(row.checkout_url),
    customer: parseJson(row.customer, null),
    meta: parseJson(row.meta, null),
    gatewayResponse: parseJson(row.gateway_response, []) ?? [],
    paidAt: parseDate(row.paid_at),
    createdAt: parseDate(row.created_at) ?? new Date(0),
    updatedAt: parseDate(row.updated_at) ?? new Date(0),
  };
}

export function paymentToRow(payment: Payment): Record<(typeof COLUMNS)[number], unknown> {
  return {
    id: payment.id,
    gateway: payment.gateway,
    reference: payment.reference,
    gateway_reference: payment.gatewayReference,
    gateway_payment_id: payment.gatewayPaymentId,
    gateway_transaction_id: payment.gatewayTransactionId,
    amount: payment.amount,
    refunded_amount: payment.refundedAmount,
    currency: payment.currency,
    status: payment.status,
    requires_review: payment.requiresReview,
    failure_reason: payment.failureReason,
    description: payment.description,
    checkout_url: payment.checkoutUrl,
    customer: payment.customer === null ? null : JSON.stringify(payment.customer),
    meta: payment.meta === null ? null : JSON.stringify(payment.meta),
    gateway_response: JSON.stringify(payment.gatewayResponse),
    paid_at: timestamp(payment.paidAt),
    created_at: timestamp(payment.createdAt),
    updated_at: timestamp(payment.updatedAt),
  };
}

export class SqlStore implements PaymentStore {
  private readonly client: SqlClient;
  private readonly dialect: Dialect;
  private readonly table: string;

  constructor(options: SqlStoreOptions) {
    this.client = options.client;
    this.dialect = options.dialect;
    const table = options.table ?? 'bdpaygate_payments';

    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(table)) {
      throw new Error(`Invalid table name [${table}].`);
    }

    this.table = this.quote(table);
  }

  private quote(identifier: string): string {
    const q = this.dialect === 'mysql' ? '`' : '"';

    return identifier
      .split('.')
      .map((part) => `${q}${part}${q}`)
      .join('.');
  }

  /** Placeholders for `count` parameters starting at `start` (1-based). */
  private placeholders(count: number, start = 1): string[] {
    return Array.from({ length: count }, (_, i) => (this.dialect === 'postgres' ? `$${start + i}` : '?'));
  }

  private get select(): string {
    const columns = COLUMNS.map((column) => {
      if (!TIMESTAMPS.has(column)) {
        return this.quote(column);
      }

      // Read timestamps as text, so no driver shifts them into local time.
      switch (this.dialect) {
        case 'postgres':
          return `to_char(${this.quote(column)}, 'YYYY-MM-DD HH24:MI:SS') AS ${this.quote(column)}`;
        case 'mysql':
          return `DATE_FORMAT(${this.quote(column)}, '%Y-%m-%d %H:%i:%s') AS ${this.quote(column)}`;
        default:
          return this.quote(column);
      }
    });

    return `SELECT ${columns.join(', ')} FROM ${this.table}`;
  }

  private value(column: string, value: unknown): unknown {
    if (column === 'requires_review' && this.dialect !== 'postgres') {
      return value ? 1 : 0;
    }

    return value;
  }

  async insert(payment: Payment): Promise<void> {
    const row = paymentToRow(payment);
    const columns = Object.keys(row);

    await this.client.query(
      `INSERT INTO ${this.table} (${columns.map((c) => this.quote(c)).join(', ')}) VALUES (${this.placeholders(columns.length).join(', ')})`,
      columns.map((c) => this.value(c, row[c as keyof typeof row])),
    );
  }

  async find(id: string): Promise<Payment | null> {
    const { rows } = await this.client.query(
      `${this.select} WHERE ${this.quote('id')} = ${this.placeholders(1)[0]}`,
      [id],
    );

    return rows[0] ? rowToPayment(rows[0]) : null;
  }

  async findBy(
    gateway: string,
    field: 'gatewayReference' | 'gatewayPaymentId',
    value: string,
  ): Promise<Payment | null> {
    const column = field === 'gatewayReference' ? 'gateway_reference' : 'gateway_payment_id';
    const [a, b] = this.placeholders(2);
    const { rows } = await this.client.query(
      `${this.select} WHERE ${this.quote('gateway')} = ${a} AND ${this.quote(column)} = ${b} LIMIT 1`,
      [gateway, value],
    );

    return rows[0] ? rowToPayment(rows[0]) : null;
  }

  async update(payment: Payment, ifStatusIn?: readonly PaymentStatus[]): Promise<boolean> {
    const row = paymentToRow({ ...payment, updatedAt: new Date() });
    const columns = Object.keys(row).filter((c) => c !== 'id' && c !== 'created_at');
    const sets = this.placeholders(columns.length);
    const params: unknown[] = columns.map((c) => this.value(c, row[c as keyof typeof row]));
    const [idPlaceholder] = this.placeholders(1, columns.length + 1);
    params.push(payment.id);

    let sql = `UPDATE ${this.table} SET ${columns.map((c, i) => `${this.quote(c)} = ${sets[i]}`).join(', ')} WHERE ${this.quote('id')} = ${idPlaceholder}`;

    if (ifStatusIn) {
      if (ifStatusIn.length === 0) {
        return false;
      }

      sql += ` AND ${this.quote('status')} IN (${this.placeholders(ifStatusIn.length, columns.length + 2).join(', ')})`;
      params.push(...ifStatusIn);
    }

    return (await this.client.query(sql, params)).rowCount > 0;
  }

  async attempts(gateway: string, reference: string): Promise<Payment[]> {
    const [a, b] = this.placeholders(2);
    const { rows } = await this.client.query(
      `${this.select} WHERE ${this.quote('gateway')} = ${a} AND ${this.quote('reference')} = ${b} ORDER BY ${this.quote('created_at')}, ${this.quote('id')}`,
      [gateway, reference],
    );

    return rows.map(rowToPayment);
  }

  async hasPaidAttempt(gateway: string, reference: string, exceptId?: string): Promise<boolean> {
    const statuses = this.placeholders(PAID_STATUSES.length, 3);
    const params: unknown[] = [gateway, reference, ...PAID_STATUSES];
    const [a, b] = this.placeholders(2);
    let sql = `SELECT ${this.quote('id')}, ${this.quote('status')} FROM ${this.table} WHERE ${this.quote('gateway')} = ${a} AND ${this.quote('reference')} = ${b} AND ${this.quote('status')} IN (${statuses.join(', ')})`;

    if (exceptId !== undefined) {
      sql += ` AND ${this.quote('id')} <> ${this.placeholders(1, PAID_STATUSES.length + 3)[0]}`;
      params.push(exceptId);
    }

    const { rows } = await this.client.query(`${sql} LIMIT 1`, params);

    return rows.some((row) => isPaid({ status: String(row.status) as PaymentStatus }));
  }

  async pending(query: PendingQuery): Promise<Payment[]> {
    const params: unknown[] = ['pending', timestamp(query.createdBefore), timestamp(query.createdAfter)];
    const [a, b, c, d] = this.placeholders(4);
    let sql = `${this.select} WHERE ${this.quote('status')} = ${a} AND ${this.quote('created_at')} <= ${b} AND ${this.quote('created_at')} >= ${c}`;

    if (query.gateway !== undefined) {
      sql += ` AND ${this.quote('gateway')} = ${d}`;
      params.push(query.gateway);
    }

    const { rows } = await this.client.query(
      `${sql} ORDER BY ${this.quote('created_at')}${query.newestFirst ? ' DESC' : ''} LIMIT ${Math.max(1, Math.floor(query.limit))}`,
      params,
    );

    return rows.map(rowToPayment);
  }
}

export function sqlStore(options: SqlStoreOptions): SqlStore {
  return new SqlStore(options);
}

// ---------------------------------------------------------------- clients

/** node-postgres (`pg`) Pool or Client, or anything with the same query(). */
export function fromPg(pool: {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}): SqlClient {
  return {
    async query(sql, params) {
      const result = await pool.query(sql, params);

      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
  };
}

/** mysql2/promise Pool or Connection. */
export function fromMysql(pool: {
  execute(sql: string, values: unknown[]): Promise<[unknown, unknown]>;
}): SqlClient {
  return {
    async query(sql, params) {
      const [result] = await pool.execute(sql, params);

      if (Array.isArray(result)) {
        return { rows: result as Record<string, unknown>[], rowCount: result.length };
      }

      return { rows: [], rowCount: Number((result as { affectedRows?: number }).affectedRows ?? 0) };
    },
  };
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint };
}

/** better-sqlite3 or node:sqlite (DatabaseSync). */
export function fromSqlite(db: { prepare(sql: string): SqliteStatement }): SqlClient {
  return {
    async query(sql, params) {
      const statement = db.prepare(sql);
      const values = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));

      if (/^\s*select/i.test(sql)) {
        return { rows: statement.all(...values) as Record<string, unknown>[], rowCount: 0 };
      }

      return { rows: [], rowCount: Number(statement.run(...values).changes) };
    },
  };
}

// ---------------------------------------------------------------- schema

/** CREATE TABLE statements for a dialect, identical in shape to the Laravel migration. */
export function createTableSql(dialect: Dialect, table = 'bdpaygate_payments'): string[] {
  const q = (name: string) => (dialect === 'mysql' ? `\`${name}\`` : `"${name}"`);
  const json = dialect === 'postgres' ? 'json' : dialect === 'mysql' ? 'json' : 'text';
  const bool =
    dialect === 'postgres'
      ? 'boolean NOT NULL DEFAULT false'
      : dialect === 'mysql'
        ? 'tinyint(1) NOT NULL DEFAULT 0'
        : 'integer NOT NULL DEFAULT 0';
  const ts =
    dialect === 'postgres'
      ? 'timestamp(0) without time zone'
      : dialect === 'mysql'
        ? 'timestamp'
        : 'datetime';
  const str = (n: number) => (dialect === 'sqlite' ? 'varchar' : `varchar(${n})`);
  const text = 'text';

  const create = `CREATE TABLE IF NOT EXISTS ${q(table)} (
  ${q('id')} ${dialect === 'sqlite' ? 'varchar' : 'char(26)'} NOT NULL PRIMARY KEY,
  ${q('gateway')} ${str(32)} NOT NULL,
  ${q('reference')} ${str(64)} NOT NULL,
  ${q('gateway_reference')} ${str(64)} NOT NULL,
  ${q('gateway_payment_id')} ${str(128)} NULL,
  ${q('gateway_transaction_id')} ${str(128)} NULL,
  ${q('amount')} ${dialect === 'sqlite' ? 'numeric' : 'decimal(12, 2)'} NOT NULL,
  ${q('refunded_amount')} ${dialect === 'sqlite' ? 'numeric' : 'decimal(12, 2)'} NOT NULL DEFAULT 0,
  ${q('currency')} ${str(3)} NOT NULL DEFAULT 'BDT',
  ${q('status')} ${str(24)} NOT NULL,
  ${q('requires_review')} ${bool},
  ${q('failure_reason')} ${str(255)} NULL,
  ${q('description')} ${str(255)} NULL,
  ${q('checkout_url')} ${text} NULL,
  ${q('customer')} ${json} NULL,
  ${q('meta')} ${json} NULL,
  ${q('gateway_response')} ${json} NULL,
  ${q('paid_at')} ${ts} NULL,
  ${q('created_at')} ${ts} NULL,
  ${q('updated_at')} ${ts} NULL
)${dialect === 'mysql' ? ' DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci' : ''}`;

  const index = (name: string, columns: string[], unique = false) =>
    dialect === 'mysql'
      ? `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(`${table}_${name}`)} ON ${q(table)} (${columns.map(q).join(', ')})`
      : `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${q(`${table}_${name}`)} ON ${q(table)} (${columns.map(q).join(', ')})`;

  return [
    create,
    index('gateway_payment_id_index', ['gateway_payment_id']),
    index('gateway_transaction_id_index', ['gateway_transaction_id']),
    index('status_index', ['status']),
    index('gateway_reference_index', ['gateway', 'reference']),
    index('gateway_gateway_reference_unique', ['gateway', 'gateway_reference'], true),
  ];
}
