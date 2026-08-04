import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lootPool, payoutParticipant } from "@/db/schema";
import { iskToCents } from "@/core/payout-split";
import {
  createOperation,
  finalizeOperation,
  recordPayment,
  revertPayment,
  setParticipantExcluded,
  setRoster,
  type RosterEntry,
} from "@/services/payouts";
import { getPayoutOperationDetail, listPayoutOperations } from "@/services/payout-view";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedOperator() {
  return seedAccount(ctx.db, { tier: "flygd", status: "active" });
}

function roster(names: string[]): RosterEntry[] {
  return names.map((displayName) => ({
    displayName,
    accountId: null,
    recipientCharacterId: null,
    sourceCharacters: [displayName],
    shares: "1",
    excluded: false,
  }));
}

/** One operation, one flat pool at the given total, and a roster of equal-
 *  share unresolved names. `setRoster`'s own `recalculate` call assigns
 *  `amount`. Returns everything a caller might need, keyed by displayName. */
async function seedOperation(opts: {
  corpSharePct?: string;
  totalValue: string;
  names: string[];
}) {
  const operator = await seedOperator();
  const { id: operationId } = await ctx.db.transaction((tx) =>
    createOperation(tx, operator.id, {
      name: "Test fight",
      occurredAt: new Date(),
      corpSharePct: opts.corpSharePct ?? "0",
    }),
  );
  const [pool] = await ctx.db
    .insert(lootPool)
    .values({
      operationId,
      valuationSource: "flat",
      totalValue: opts.totalValue,
      notes: "seeded directly",
    })
    .returning();
  await ctx.db.transaction((tx) =>
    setRoster(tx, operator.id, operationId, roster(opts.names)),
  );
  const rows = await ctx.db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));
  const byName = new Map(rows.map((r) => [r.displayName, r]));
  return { operator, operationId, poolId: pool.id, byName };
}

describe("listPayoutOperations", () => {
  it("excludes excluded participants from both participantCount and paidCount", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A", "B", "C"],
    });
    await ctx.db.transaction((tx) =>
      setParticipantExcluded(tx, operator.id, byName.get("A")!.id, true),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("B")!.id));

    const [summary] = (await listPayoutOperations(ctx.db)).filter(
      (o) => o.id === operationId,
    );
    // A is excluded (not owed anything, not counted); B and C are owed, and
    // only B has been paid.
    expect(summary.participantCount).toBe(2);
    expect(summary.paidCount).toBe(1);
  });
});

describe("getPayoutOperationDetail — paymentState", () => {
  it("maps excluded / unpaid / paid correctly per participant", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["Excluded", "Unpaid", "Paid"],
    });
    await ctx.db.transaction((tx) =>
      setParticipantExcluded(tx, operator.id, byName.get("Excluded")!.id, true),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) =>
      recordPayment(tx, operator.id, byName.get("Paid")!.id),
    );

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const states = new Map(
      detail!.participants.map((p) => [p.displayName, p.paymentState]),
    );
    expect(states.get("Excluded")).toBe("excluded");
    expect(states.get("Unpaid")).toBe("unpaid");
    expect(states.get("Paid")).toBe("paid");
  });
});

describe("getPayoutOperationDetail — exact money on the read side", () => {
  it("sums a pool total past 2^53 without precision loss", async () => {
    // 2^53 = 9,007,199,254,740,992. A float total would silently round this;
    // bigint cents must not. Two pools so the summation itself is exercised,
    // not just a single already-oversized string passing through unchanged.
    const operator = await seedOperator();
    const { id: operationId } = await ctx.db.transaction((tx) =>
      createOperation(tx, operator.id, {
        name: "Absurd fight",
        occurredAt: new Date(),
        corpSharePct: "0",
      }),
    );
    await ctx.db.insert(lootPool).values([
      {
        operationId,
        valuationSource: "flat",
        totalValue: "9007199254740992.01",
        notes: "pool one",
      },
      {
        operationId,
        valuationSource: "flat",
        totalValue: "9007199254740992.01",
        notes: "pool two",
      },
    ]);
    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    expect(detail!.totalValue).toBe("18014398509481984.02");
    // listPayoutOperations sums the same pools in its own separate loop
    // (src/services/payout-view.ts) — a Number() regression there wouldn't
    // show up in getPayoutOperationDetail's assertion above.
    const [summary] = await listPayoutOperations(ctx.db);
    expect(summary.totalValue).toBe("18014398509481984.02");
  });

  it("derives corp share as total minus the sum of participant amounts, remainder included", async () => {
    // 100.01 ISK / 3 equal shares at 10% corp share does not divide evenly;
    // the leftover cent must land on the corp (via the derivation), never
    // vanish or get double-counted. Comparing in bigint cents, not floats,
    // is the whole point of this test: it must catch a Number()-based
    // corpAmount = total * pct / 100 that ignores the rounding remainder.
    const CORP_SHARE_PCT = "10";
    const { operationId } = await seedOperation({
      corpSharePct: CORP_SHARE_PCT,
      totalValue: "100.01",
      names: ["A", "B", "C"],
    });
    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const assignedCents = detail!.participants.reduce(
      (sum, p) => sum + iskToCents(p.amount),
      0n,
    );
    const totalCents = iskToCents(detail!.totalValue);
    expect(iskToCents(detail!.corpAmount)).toBe(totalCents - assignedCents);
    // Reconciles exactly against what recalculate actually wrote — the whole
    // point of deriving rather than storing a second copy of the number.
    expect(assignedCents + iskToCents(detail!.corpAmount)).toBe(totalCents);
    // Literal anchors: every assertion above is relational only ("derived
    // corp equals total minus the amounts just read back"), so a regression
    // in recalculate itself would still reconcile and pass. 100.01 ISK split
    // 3 equal ways after a 10% corp share is 30.00 ISK per participant and
    // 10.01 ISK to the corp (the extra cent is the undistributed remainder).
    expect(detail!.corpAmount).toBe("10.01");
    expect(detail!.participants[0].amount).toBe("30.00");
    // A naive total * pct / 100 would give 10.00, not the derived remainder
    // that also swallows the assignment rounding — pin the two disagree.
    // Basis points derived from the same constant the fixture uses above, so
    // editing CORP_SHARE_PCT can't silently stop this from comparing against
    // the naive formula.
    const naiveBasisPoints = BigInt(Number(CORP_SHARE_PCT)) * 100n;
    expect(iskToCents(detail!.corpAmount)).not.toBe(
      (totalCents * naiveBasisPoints) / 10000n,
    );
  });
});

describe("derived payment state comes from paidAmount, not from a paid row", () => {
  it("reports a paid-then-reverted participant as unpaid in both the list and the detail", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A", "B"],
    });
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("A")!.id));
    await ctx.db.transaction((tx) => recordPayment(tx, operator.id, byName.get("B")!.id));
    await ctx.db.transaction((tx) => revertPayment(tx, operator.id, byName.get("A")!.id));

    // A still has a `paid` row in payout_payment; an existence check would
    // count it. paidAmount is null, and that is what decides.
    const [summary] = (await listPayoutOperations(ctx.db)).filter(
      (o) => o.id === operationId,
    );
    expect(summary.paidCount).toBe(1);

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const states = new Map(
      detail!.participants.map((p) => [p.displayName, p.paymentState]),
    );
    expect(states.get("A")).toBe("unpaid");
    expect(states.get("B")).toBe("paid");
  });

  it("returns each participant's history oldest-first", async () => {
    const { operator, operationId, byName } = await seedOperation({
      totalValue: "300.00",
      names: ["A"],
    });
    await ctx.db.transaction((tx) => finalizeOperation(tx, operator.id, operationId));
    await ctx.db.transaction(async (tx) => {
      await recordPayment(tx, operator.id, byName.get("A")!.id);
      await revertPayment(tx, operator.id, byName.get("A")!.id);
      await recordPayment(tx, operator.id, byName.get("A")!.id);
    });

    const detail = await getPayoutOperationDetail(ctx.db, operationId);
    const a = detail!.participants.find((p) => p.displayName === "A")!;
    expect(a.payments.map((p) => p.kind)).toEqual(["paid", "reverted", "paid"]);
    expect(a.paymentState).toBe("paid");
  });
});
