import { eq } from "drizzle-orm";
import type { DbTx } from "@/db";
import { lootItem, lootPool } from "@/db/schema";
import type { PricingMode } from "@/core/pricing";
import { centsToIsk, iskToCents } from "@/core/payout-split";
import { logAudit } from "@/services/audit";
import {
  assertEditable,
  lockOperation,
  recalculate,
  requirePayoutOperator,
} from "@/services/payouts";
import type { AppraisalResult } from "@/services/appraisal";

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
  const computedTotal = centsToIsk(
    input.appraisal.items.reduce((sum, it) => sum + iskToCents(it.totalValue), 0n),
  );
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
  // Validates the same ISK-decimal shape iskToCents enforces everywhere else
  // money enters the system; the return value is unused here, only the
  // format check (iskToCents throws on anything else).
  iskToCents(input.totalValue);
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

export async function deletePool(dbtx: DbTx, actor: string, poolId: string): Promise<void> {
  await requirePayoutOperator(dbtx, actor);
  const [pool] = await dbtx.select().from(lootPool).where(eq(lootPool.id, poolId));
  if (!pool) throw new Error("pool not found");
  await lockOperation(dbtx, pool.operationId);
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
