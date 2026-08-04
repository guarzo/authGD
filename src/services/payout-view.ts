import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
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

export const PAYOUTS_PAGE_SIZE = 50;

/**
 * Composite by necessity. `occurredAt` is not unique and `payoutOperation.id`
 * is a random uuid, so neither column alone can resume a scan: a bare
 * timestamp cursor pages past every operation that shares a date with the last
 * row of the previous page. `auditLog`'s monotonic serial needs no such pair.
 */
export type PayoutListCursor = { occurredAt: Date; id: string };

export type PayoutListPage = {
  operations: PayoutOperationSummary[];
  /** Non-null exactly when a further page exists — derived by reading one row
   *  past the limit, so no COUNT(*) over the whole table is issued to answer
   *  "is there an Older button". */
  nextCursor: PayoutListCursor | null;
};

const CURSOR_SEPARATOR = "|";
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function encodePayoutCursor(cursor: PayoutListCursor): string {
  return `${cursor.occurredAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`;
}

/**
 * Defensive by contract: `before` arrives from a URL anyone can hand-edit, and
 * an unparseable date or a non-uuid tiebreak would otherwise reach Postgres as
 * an invalid comparison and take the list page down. Anything it cannot read
 * means "start from the top".
 */
export function decodePayoutCursor(
  raw: string | undefined,
): PayoutListCursor | undefined {
  if (!raw) return undefined;
  const parts = raw.split(CURSOR_SEPARATOR);
  if (parts.length !== 2) return undefined;
  const [iso, id] = parts;
  if (!UUID_RE.test(id)) return undefined;
  const occurredAt = new Date(iso);
  if (Number.isNaN(occurredAt.getTime())) return undefined;
  return { occurredAt, id };
}

/**
 * One row per operation for the /payouts list. Reads only — the list page has
 * nothing to protect, unlike setRoster/addAppraisedPool/etc, which is why this
 * lives outside the guarded service in src/services/payouts.ts.
 *
 * Three queries, all bounded. The child queries are scoped to this page's ids;
 * there is no payment query, because a participant's `paidAmount` already
 * answers what it used to be consulted for.
 */
export async function listPayoutOperations(
  dbx: Dbx,
  opts: { before?: PayoutListCursor; limit?: number } = {},
): Promise<PayoutListPage> {
  const limit = Math.min(opts.limit ?? PAYOUTS_PAGE_SIZE, PAYOUTS_PAGE_SIZE);
  const before = opts.before;

  // Explicit column lists, not `select()`. A bare select on loot_pool drags
  // every operation's `raw_paste` — an entire pasted inventory window, per
  // pool — across the wire to compute one sum. Nothing below reads a column
  // that is not named here.
  //
  // One row past the limit: its presence is the "there is more" signal, and
  // the row itself is trimmed before anything downstream sees it.
  const page = await dbx
    .select({
      id: payoutOperation.id,
      name: payoutOperation.name,
      occurredAt: payoutOperation.occurredAt,
      status: payoutOperation.status,
    })
    .from(payoutOperation)
    .where(
      before
        ? or(
            lt(payoutOperation.occurredAt, before.occurredAt),
            and(
              eq(payoutOperation.occurredAt, before.occurredAt),
              lt(payoutOperation.id, before.id),
            ),
          )
        : undefined,
    )
    .orderBy(desc(payoutOperation.occurredAt), desc(payoutOperation.id))
    .limit(limit + 1);

  const hasMore = page.length > limit;
  const ops = hasMore ? page.slice(0, limit) : page;
  const pageIds = ops.map((o) => o.id);

  type PoolRow = { operationId: string; totalValue: string };
  type ParticipantRow = {
    id: string;
    operationId: string;
    excluded: boolean;
    paidAmount: string | null;
  };
  const [pools, participants]: [PoolRow[], ParticipantRow[]] = pageIds.length
    ? await Promise.all([
        dbx
          .select({ operationId: lootPool.operationId, totalValue: lootPool.totalValue })
          .from(lootPool)
          .where(inArray(lootPool.operationId, pageIds)),
        dbx
          .select({
            id: payoutParticipant.id,
            operationId: payoutParticipant.operationId,
            excluded: payoutParticipant.excluded,
            paidAmount: payoutParticipant.paidAmount,
          })
          .from(payoutParticipant)
          .where(inArray(payoutParticipant.operationId, pageIds)),
      ])
    : [[], []];

  // bigint cents, not Number: numeric(20,2) holds values far past 2^53, and the
  // "no floats" constraint is not relaxed just because this is the read side.
  const totalByOp = new Map<string, bigint>();
  for (const p of pools) {
    totalByOp.set(
      p.operationId,
      (totalByOp.get(p.operationId) ?? 0n) + iskToCents(p.totalValue),
    );
  }
  const participantsByOp = new Map<string, ParticipantRow[]>();
  for (const p of participants) {
    const list = participantsByOp.get(p.operationId) ?? [];
    list.push(p);
    participantsByOp.set(p.operationId, list);
  }

  const operations = ops.map((op) => {
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
      // paidAmount, not a payment row: revert clears it under the operation
      // lock, so a paid-then-reverted participant reads unpaid here without
      // this function folding an event history to find that out.
      paidCount: owed.filter((p) => p.paidAmount !== null).length,
    };
  });

  const last = ops[ops.length - 1];
  return {
    operations,
    nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null,
  };
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
