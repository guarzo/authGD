import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Dbx } from "@/db";
import {
  lootItem,
  lootPool,
  payoutOperation,
  payoutParticipant,
  payoutPayment,
} from "@/db/schema";
import { hasPayments } from "@/services/payouts";
import { centsToIsk, iskToCents } from "@/core/payout-split";

export type PayoutOperationSummary = {
  id: string;
  name: string;
  occurredAt: Date;
  status: "draft" | "finalized";
  totalValue: string;
  participantCount: number;
  paidCount: number;
};

/**
 * One row per operation for the /payouts list. Reads only — the list page has
 * nothing to protect, unlike setRoster/addAppraisedPool/etc, which is why this
 * lives outside the guarded service in src/services/payouts.ts.
 */
export async function listPayoutOperations(dbx: Dbx): Promise<PayoutOperationSummary[]> {
  // Explicit column lists, not `select()`. A bare select on loot_pool drags
  // every operation's `raw_paste` — an entire pasted inventory window, per
  // pool — across the wire to compute one sum. Nothing below reads a column
  // that is not named here.
  const [ops, pools, participants] = await Promise.all([
    dbx
      .select({
        id: payoutOperation.id,
        name: payoutOperation.name,
        occurredAt: payoutOperation.occurredAt,
        status: payoutOperation.status,
      })
      .from(payoutOperation)
      .orderBy(desc(payoutOperation.occurredAt)),
    dbx
      .select({ operationId: lootPool.operationId, totalValue: lootPool.totalValue })
      .from(lootPool),
    dbx
      .select({
        id: payoutParticipant.id,
        operationId: payoutParticipant.operationId,
        excluded: payoutParticipant.excluded,
        paidAmount: payoutParticipant.paidAmount,
      })
      .from(payoutParticipant),
  ]);

  // bigint cents, not Number: numeric(20,2) holds values far past 2^53, and the
  // "no floats" constraint is not relaxed just because this is the read side.
  const totalByOp = new Map<string, bigint>();
  for (const p of pools) {
    totalByOp.set(
      p.operationId,
      (totalByOp.get(p.operationId) ?? 0n) + iskToCents(p.totalValue),
    );
  }
  const participantsByOp = new Map<string, typeof participants>();
  for (const p of participants) {
    const list = participantsByOp.get(p.operationId) ?? [];
    list.push(p);
    participantsByOp.set(p.operationId, list);
  }
  // `paidAmount` is the source of truth for derived payment state, not a fold
  // of payout_payment: it is one column, written under the same operation row
  // lock that decides on it, so it cannot disagree with itself. The event log
  // stays append-only history — displayed, never folded into a decision.

  return ops.map((op) => {
    // Excluded rows are not owed anything and are not part of "how many have
    // been paid" — an all-excluded roster reading as 0/0 rather than 0/N.
    const owed = (participantsByOp.get(op.id) ?? []).filter((p) => !p.excluded);
    return {
      id: op.id,
      name: op.name,
      occurredAt: op.occurredAt,
      status: op.status,
      totalValue: centsToIsk(totalByOp.get(op.id) ?? 0n),
      participantCount: owed.length,
      paidCount: owed.filter((p) => p.paidAmount !== null).length,
    };
  });
}

export type PayoutPoolView = typeof lootPool.$inferSelect & {
  items: Array<typeof lootItem.$inferSelect>;
};

export type ParticipantPaymentState = "excluded" | "unpaid" | "paid";

export type PayoutParticipantView = typeof payoutParticipant.$inferSelect & {
  paymentState: ParticipantPaymentState;
  /** Append-only history for this participant, `(at asc, id asc)`. Rendered,
   *  never folded — `paymentState` comes from `paidAmount`. */
  payments: Array<typeof payoutPayment.$inferSelect>;
};

export type PayoutOperationDetail = {
  operation: typeof payoutOperation.$inferSelect;
  pools: PayoutPoolView[];
  participants: PayoutParticipantView[];
  totalValue: string;
  /** Derived, not stored: totalValue minus every participant's amount. This is
   *  the corp's configured percentage plus all rounding remainders — the number
   *  that makes the displayed split add up to the total. */
  corpAmount: string;
  /** hasPayments(operationId) — once true, every edit action rejects via
   *  assertEditable; the page uses this to hide those controls instead of
   *  letting a member discover the rejection by submitting. */
  locked: boolean;
};

export async function getPayoutOperationDetail(
  dbx: Dbx,
  operationId: string,
): Promise<PayoutOperationDetail | null> {
  const [op] = await dbx
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.id, operationId));
  if (!op) return null;

  const [pools, participants, locked] = await Promise.all([
    dbx.select().from(lootPool).where(eq(lootPool.operationId, operationId)),
    dbx
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId))
      .orderBy(asc(payoutParticipant.displayName)),
    hasPayments(dbx, operationId),
  ]);

  const poolIds = pools.map((p) => p.id);
  const items = poolIds.length
    ? await dbx.select().from(lootItem).where(inArray(lootItem.poolId, poolIds))
    : [];
  const itemsByPool = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByPool.get(item.poolId) ?? [];
    list.push(item);
    itemsByPool.set(item.poolId, list);
  }

  const participantIds = participants.map((p) => p.id);
  const payments = participantIds.length
    ? await dbx
        .select()
        .from(payoutPayment)
        .where(inArray(payoutPayment.participantId, participantIds))
        .orderBy(asc(payoutPayment.at), asc(payoutPayment.id))
    : [];
  const paymentsByParticipant = new Map<string, typeof payments>();
  for (const payment of payments) {
    const list = paymentsByParticipant.get(payment.participantId) ?? [];
    list.push(payment);
    paymentsByParticipant.set(payment.participantId, list);
  }

  const totalCents = pools.reduce((sum, p) => sum + iskToCents(p.totalValue), 0n);
  // The corp's cut is not stored — storing it would be a second copy of a number
  // computeSplit already derives, and the two could drift. It is exactly the
  // part of the pot no participant was assigned: the configured percentage plus
  // every sub-ISK rounding remainder. Deriving it here means it always agrees
  // with what recalculate wrote, by construction.
  const assignedCents = participants.reduce((sum, p) => sum + iskToCents(p.amount), 0n);
  const corpAmount = centsToIsk(totalCents - assignedCents);

  return {
    operation: op,
    pools: pools.map((p) => ({ ...p, items: itemsByPool.get(p.id) ?? [] })),
    participants: participants.map((p) => ({
      ...p,
      paymentState: p.excluded ? "excluded" : p.paidAmount !== null ? "paid" : "unpaid",
      payments: paymentsByParticipant.get(p.id) ?? [],
    })),
    totalValue: centsToIsk(totalCents),
    corpAmount,
    locked,
  };
}
