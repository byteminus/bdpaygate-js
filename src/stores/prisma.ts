/**
 * Prisma. Add the model from node_modules/bdpaygate/prisma/bdpaygate.prisma
 * to your schema, migrate, then:
 *
 *     import { prismaStore } from 'bdpaygate/stores/prisma';
 *     const store = prismaStore(prisma.bdpaygatePayment);
 */
import { toFixed2 } from '../core/payment.js';
import type { PaymentStore, PendingQuery } from '../core/store.js';
import {
  type GatewayResponseEntry,
  type JsonObject,
  PAID_STATUSES,
  type Payment,
  type PaymentStatus,
  type StoredCustomer,
} from '../core/types.js';

/** The fields of the BdpaygatePayment model, as Prisma returns them. */
export interface PrismaPaymentRow {
  id: string;
  gateway: string;
  reference: string;
  gatewayReference: string;
  gatewayPaymentId: string | null;
  gatewayTransactionId: string | null;
  /** Prisma.Decimal, number or string. */
  amount: unknown;
  refundedAmount: unknown;
  currency: string;
  status: string;
  requiresReview: boolean;
  failureReason: string | null;
  description: string | null;
  checkoutUrl: string | null;
  customer: unknown;
  meta: unknown;
  gatewayResponse: unknown;
  paidAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

type Where = Record<string, unknown>;

/** The subset of a Prisma model delegate (prisma.bdpaygatePayment) the store uses. */
export interface PrismaPaymentDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: { where: { id: string } }): Promise<PrismaPaymentRow | null>;
  findFirst(args: {
    where: Where;
    select?: Record<string, boolean>;
  }): Promise<Partial<PrismaPaymentRow> | null>;
  findMany(args: {
    where: Where;
    orderBy?: Record<string, 'asc' | 'desc'>[];
    take?: number;
  }): Promise<PrismaPaymentRow[]>;
  updateMany(args: { where: Where; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function fromRow(row: PrismaPaymentRow): Payment {
  return {
    id: row.id,
    gateway: row.gateway,
    reference: row.reference,
    gatewayReference: row.gatewayReference,
    gatewayPaymentId: row.gatewayPaymentId,
    gatewayTransactionId: row.gatewayTransactionId,
    amount: toFixed2(Number(String(row.amount))),
    refundedAmount: toFixed2(Number(String(row.refundedAmount ?? 0))),
    currency: row.currency,
    status: row.status as PaymentStatus,
    requiresReview: row.requiresReview,
    failureReason: row.failureReason,
    description: row.description,
    checkoutUrl: row.checkoutUrl,
    customer: (row.customer ?? null) as StoredCustomer | null,
    meta: (row.meta ?? null) as JsonObject | null,
    gatewayResponse: (Array.isArray(row.gatewayResponse)
      ? row.gatewayResponse
      : []) as GatewayResponseEntry[],
    paidAt: row.paidAt,
    createdAt: row.createdAt ?? new Date(0),
    updatedAt: row.updatedAt ?? new Date(0),
  };
}

function toData(payment: Payment): Record<string, unknown> {
  // Prisma's Json fields reject Date objects: the log only holds plain JSON already.
  const { id: _id, createdAt: _createdAt, ...rest } = payment;

  return { ...rest, gatewayResponse: payment.gatewayResponse };
}

export class PrismaStore implements PaymentStore {
  constructor(private readonly model: PrismaPaymentDelegate) {}

  async insert(payment: Payment): Promise<void> {
    await this.model.create({ data: { ...toData(payment), id: payment.id, createdAt: payment.createdAt } });
  }

  async find(id: string): Promise<Payment | null> {
    const row = await this.model.findUnique({ where: { id } });

    return row ? fromRow(row) : null;
  }

  async findBy(
    gateway: string,
    field: 'gatewayReference' | 'gatewayPaymentId',
    value: string,
  ): Promise<Payment | null> {
    const row = await this.model.findFirst({ where: { gateway, [field]: value } });

    return row ? fromRow(row as PrismaPaymentRow) : null;
  }

  async update(payment: Payment, ifStatusIn?: readonly PaymentStatus[]): Promise<boolean> {
    if (ifStatusIn && ifStatusIn.length === 0) {
      return false;
    }

    const where: Where = { id: payment.id };

    if (ifStatusIn) {
      where.status = { in: [...ifStatusIn] };
    }

    const { count } = await this.model.updateMany({
      where,
      data: { ...toData(payment), updatedAt: new Date() },
    });

    return count > 0;
  }

  async attempts(gateway: string, reference: string): Promise<Payment[]> {
    const rows = await this.model.findMany({
      where: { gateway, reference },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map(fromRow);
  }

  async hasPaidAttempt(gateway: string, reference: string, exceptId?: string): Promise<boolean> {
    const where: Where = { gateway, reference, status: { in: [...PAID_STATUSES] } };

    if (exceptId !== undefined) {
      where.id = { not: exceptId };
    }

    return (await this.model.findFirst({ where, select: { id: true } })) !== null;
  }

  async pending(query: PendingQuery): Promise<Payment[]> {
    const where: Where = {
      status: 'pending',
      createdAt: { lte: query.createdBefore, gte: query.createdAfter },
    };

    if (query.gateway !== undefined) {
      where.gateway = query.gateway;
    }

    const rows = await this.model.findMany({
      where,
      orderBy: [{ createdAt: query.newestFirst ? 'desc' : 'asc' }],
      take: query.limit,
    });

    return rows.map(fromRow);
  }
}

export function prismaStore(model: PrismaPaymentDelegate): PrismaStore {
  return new PrismaStore(model);
}
