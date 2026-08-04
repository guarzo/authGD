import { eq } from "drizzle-orm";
import type { DbTx } from "@/db";
import { lootItem, lootPool } from "@/db/schema";
import type { PricingMode } from "@/core/pricing";
import { MAX_MONEY_CENTS, centsToIsk, iskToCents } from "@/core/payout-split";
import { logAudit } from "@/services/audit";
import {
  PayoutNotFoundError,
  assertEditable,
  lockOperation,
  recalculate,
  requirePayoutOperator,
} from "@/services/payouts";
import type { AppraisalResult } from "@/services/appraisal";

/**
 * `numeric(20, 2)` holds up to 999999999999999999.99 ISK. Past that, an insert
 * dies as a Drizzle "Failed query" wrapper around a Postgres numeric overflow,
 * which tells the operator nothing about which line was absurd. This is the
 * same failure defect 9's quantity bound reaches from the other side.
 */
function assertWithinMoneyRange(cents: bigint, what: string): void {
  if (cents > MAX_MONEY_CENTS) {
    throw new Error(`${what} exceeds the largest value this system can record`);
  }
}

export async function addAppraisedPool(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  input: {
    rawPaste: string;
    pricingMode: PricingMode;
    stationId?: number | null;
    regionId?: number | null;
    appraisal: AppraisalResult;
  },
): Promise<{ poolId: string }> {
  await requirePayoutOperator(dbtx, actor);
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  // The pool's totalValue is derived from the item rows, never trusted from
  // the caller's appraisal.totalValue — the two are computed by the same
  // formula today, but only one of them is the row that actually lands in
  // loot_item, and a caller that passes a stale or edited totalValue must
  // not be able to make the persisted pool disagree with its own items.
  let totalCents = 0n;
  for (const it of input.appraisal.items) {
    const lineCents = iskToCents(it.totalValue);
    assertWithinMoneyRange(lineCents, `the line total for ${it.name}`);
    totalCents += lineCents;
  }
  assertWithinMoneyRange(totalCents, "this pool's total");
  const computedTotal = centsToIsk(totalCents);
  const [pool] = await dbtx
    .insert(lootPool)
    .values({
      operationId,
      rawPaste: input.rawPaste,
      valuationSource: "appraised",
      pricingMode: input.pricingMode,
      stationId: input.stationId ?? null,
      regionId: input.regionId ?? null,
      totalValue: computedTotal,
      appraisedAt: new Date(),
    })
    .returning();
  if (input.appraisal.items.length > 0) {
    await dbtx.insert(lootItem).values(
      input.appraisal.items.map((it) => ({
        poolId: pool.id,
        typeId: it.typeId,
        name: it.name,
        qty: it.qty,
        unitPrice: it.unitPrice,
        totalValue: it.totalValue,
        // "manual" (a per-item price override) is a PR2 concern; appraiseLoot
        // only ever emits "triff" or "unresolved".
        priceSource: it.priceSource,
      })),
    );
  }
  await logAudit(dbtx, {
    actor,
    action: "payout.pool_added",
    target: operationId,
    details: { poolId: pool.id, valuationSource: "appraised" },
  });
  await recalculate(dbtx, operationId);
  return { poolId: pool.id };
}

export async function addFlatPool(
  dbtx: DbTx,
  actor: string,
  operationId: string,
  input: { rawPaste?: string | null; totalValue: string; notes: string },
): Promise<{ poolId: string }> {
  // requirePayoutOperator is the FIRST statement, per the plan's Global
  // Constraints — an actor who cannot mutate payouts is rejected before any
  // other validation runs, note-content included.
  await requirePayoutOperator(dbtx, actor);
  // Mirrors the DB CHECK (loot_pool_flat_note_ck) with a friendlier message,
  // checked before taking any lock since it needs no operation state.
  if (!input.notes.trim()) {
    throw new Error("a flat pool requires a note explaining the negotiated total");
  }
  // iskToCents validates the ISK-decimal shape (throws on anything else,
  // same guard every other money entry point uses) but its regex allows a
  // leading minus, so a negative total would otherwise reach the insert and
  // die on loot_pool_total_ck with an unreadable Drizzle "Failed query"
  // error -- exactly what this guard exists to prevent. Zero stays allowed.
  if (iskToCents(input.totalValue) < 0n) {
    throw new Error("a flat pool total cannot be negative");
  }
  await lockOperation(dbtx, operationId);
  await assertEditable(dbtx, operationId);
  const [pool] = await dbtx
    .insert(lootPool)
    .values({
      operationId,
      rawPaste: input.rawPaste ?? null,
      valuationSource: "flat",
      totalValue: input.totalValue,
      notes: input.notes,
    })
    .returning();
  await logAudit(dbtx, {
    actor,
    action: "payout.pool_added",
    target: operationId,
    details: { poolId: pool.id, valuationSource: "flat" },
  });
  await recalculate(dbtx, operationId);
  return { poolId: pool.id };
}

/**
 * A manual per-item price override, for the items an appraisal could not
 * resolve. Lives here rather than in payouts.ts because it has to keep the
 * pool's derived `totalValue` consistent with its item rows, which is
 * `addAppraisedPool`'s job too.
 *
 * Calls `assertEditable`: this moves money.
 *
 * Precision. `unitPrice` is `numeric(20, 2)`, so a manual price is exactly two
 * decimals; the action refuses a third rather than silently rounding a number
 * someone typed deliberately. The payoff is that invariant 2 ("round once at
 * the line total") has nothing to round here — `unitPriceCents * qty` is an
 * exact bigint product, and because the price is already at cent precision,
 * per-unit and line-total rounding coincide. This is not a forgotten rounding
 * step.
 *
 * The deliberate inconsistency, named so nobody "fixes" it: for an APPRAISED
 * item, `unitPrice` is a lossy 2dp rendering of a sub-cent market price while
 * `totalValue` came from the full-precision one, so `unitPrice * qty` does NOT
 * reproduce `totalValue` — that gap is what the detail page's sub-cent warning
 * reports. For a MANUAL item the two agree exactly, by the paragraph above.
 *
 * `rawPaste` is untouched: phase 1 keeps it verbatim precisely so the pool can
 * be re-appraised later, and an override must not cost that.
 */
export async function setItemPrice(
  dbtx: DbTx,
  actor: string,
  itemId: string,
  unitPrice: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const [ref] = await dbtx.select().from(lootItem).where(eq(lootItem.id, itemId));
  if (!ref) throw new PayoutNotFoundError("loot item not found");
  const [pool] = await dbtx.select().from(lootPool).where(eq(lootPool.id, ref.poolId));
  if (!pool) throw new PayoutNotFoundError("loot pool not found");
  await lockOperation(dbtx, pool.operationId);
  await assertEditable(dbtx, pool.operationId);
  // Re-read after the lock: `qty` is what the line total is computed from, and
  // a concurrent re-appraisal could have replaced it since the read above.
  const [item] = await dbtx.select().from(lootItem).where(eq(lootItem.id, itemId));
  if (!item) throw new PayoutNotFoundError("loot item not found");

  const unitPriceCents = iskToCents(unitPrice);
  // iskToCents' regex admits a leading minus, so this is the guard that keeps a
  // negative price from dying on loot_item_price_ck instead.
  if (unitPriceCents < 0n) throw new Error("a unit price cannot be negative");
  const lineCents = unitPriceCents * BigInt(item.qty);
  assertWithinMoneyRange(lineCents, `the line total for ${item.name}`);

  await dbtx
    .update(lootItem)
    .set({
      unitPrice: centsToIsk(unitPriceCents),
      totalValue: centsToIsk(lineCents),
      priceSource: "manual",
    })
    .where(eq(lootItem.id, itemId));

  // Re-derive the pool total from the item rows, never from a running sum or a
  // caller-supplied number — same rule addAppraisedPool follows.
  const siblings = await dbtx
    .select({ totalValue: lootItem.totalValue })
    .from(lootItem)
    .where(eq(lootItem.poolId, item.poolId));
  const poolCents = siblings.reduce((sum, it) => sum + iskToCents(it.totalValue), 0n);
  assertWithinMoneyRange(poolCents, "this pool's total");
  await dbtx
    .update(lootPool)
    .set({ totalValue: centsToIsk(poolCents) })
    .where(eq(lootPool.id, item.poolId));

  await logAudit(dbtx, {
    actor,
    action: "payout.item_repriced",
    target: pool.operationId,
    details: {
      itemId,
      poolId: item.poolId,
      name: item.name,
      unitPrice: centsToIsk(unitPriceCents),
    },
  });
  await recalculate(dbtx, pool.operationId);
}

export async function deletePool(
  dbtx: DbTx,
  actor: string,
  poolId: string,
): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const [pool] = await dbtx.select().from(lootPool).where(eq(lootPool.id, poolId));
  if (!pool) throw new Error("pool not found");
  await lockOperation(dbtx, pool.operationId);
  // pool.operationId is immutable, so the lock above is already ordered
  // correctly, but two concurrent deletes of the SAME pool both read it before
  // either takes the lock. Re-read after the lock and bail out if it's already
  // gone, so the loser doesn't also delete zero rows and still log its own
  // payout.pool_deleted audit entry.
  const [stillThere] = await dbtx.select().from(lootPool).where(eq(lootPool.id, poolId));
  if (!stillThere) return;
  await assertEditable(dbtx, pool.operationId);
  await dbtx.delete(lootPool).where(eq(lootPool.id, poolId)); // cascades loot_item
  await logAudit(dbtx, {
    actor,
    action: "payout.pool_deleted",
    target: pool.operationId,
    details: { poolId },
  });
  await recalculate(dbtx, pool.operationId);
}
