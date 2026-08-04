import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  lootItem,
  lootPool,
  payoutOperation,
  payoutParticipant,
  auditLog,
} from "@/db/schema";
import {
  PayoutForbiddenError,
  PayoutLockedError,
  createOperation,
  finalizeOperation,
  recordPayment,
  setRoster,
  type RosterEntry,
} from "@/services/payouts";
import { addAppraisedPool, addFlatPool, deletePool } from "@/services/payout-loot";
import { setupTestDb, truncateAll } from "./helpers/db";
import { expectCheckViolation } from "./helpers/constraints";
import { seedAccount } from "./helpers/seed";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function seedOperation() {
  const operator = await seedAccount(ctx.db, { tier: "flygd", status: "active" });
  const { id: operationId } = await ctx.db.transaction((tx) =>
    createOperation(tx, operator.id, {
      name: "Fight",
      occurredAt: new Date(),
      corpSharePct: "0",
    }),
  );
  const roster: RosterEntry[] = [
    {
      displayName: "Line Member",
      accountId: null,
      recipientCharacterId: null,
      sourceCharacters: ["Line Member"],
      shares: "1",
      excluded: false,
    },
  ];
  await ctx.db.transaction((tx) => setRoster(tx, operator.id, operationId, roster));
  return { operatorId: operator.id, operationId };
}

async function soleParticipantAmount(operationId: string) {
  const [p] = await ctx.db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, operationId));
  return p.amount;
}

/**
 * Blocks until `count` backends on this database are parked on a lock. Used
 * to observe that concurrent transactions have genuinely reached
 * `lockOperation` and queued, which is the state the serialization test is
 * about — a fixed sleep can only guess at it.
 *
 * The polling connection is a fourth checkout from a pool of five (blocker
 * plus two attempts hold the other three), so it never waits on the pool.
 */
async function waitForLockWaiters(count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ctx.db.execute(sql`
      select count(*)::int as n
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and pid <> pg_backend_pid()`);
    if (Number((res.rows[0] as { n: number }).n) >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} backends to block on a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("addAppraisedPool", () => {
  it("keeps an unresolved item as a visible zero-priced row and still totals the resolved lines", async () => {
    const { operatorId, operationId } = await seedOperation();
    await ctx.db.transaction((tx) =>
      addAppraisedPool(tx, operatorId, operationId, {
        rawPaste: "3x Unknown Junk\n2x Tritanium",
        pricingMode: "sell_best",
        stationId: 60003760,
        appraisal: {
          items: [
            {
              typeId: null,
              name: "Unknown Junk",
              qty: 3,
              unitPrice: "0.00",
              totalValue: "0.00",
              priceSource: "unresolved",
            },
            {
              typeId: 34,
              name: "Tritanium",
              qty: 2,
              unitPrice: "5.00",
              totalValue: "10.00",
              priceSource: "triff",
            },
          ],
          totalValue: "10.00",
          dropped: [],
        },
      }),
    );
    const items = await ctx.db.select().from(lootItem);
    expect(items).toHaveLength(2);
    const junk = items.find((i) => i.name === "Unknown Junk")!;
    expect(junk.priceSource).toBe("unresolved");
    expect(junk.totalValue).toBe("0.00");
    expect(await soleParticipantAmount(operationId)).toBe("10.00");
  });

  it("derives the persisted pool total from the item rows, not from a caller-supplied appraisal.totalValue that disagrees with them", async () => {
    const { operatorId, operationId } = await seedOperation();
    const { poolId } = await ctx.db.transaction((tx) =>
      addAppraisedPool(tx, operatorId, operationId, {
        rawPaste: "2x Tritanium",
        pricingMode: "sell_best",
        stationId: 60003760,
        appraisal: {
          items: [
            {
              typeId: 34,
              name: "Tritanium",
              qty: 2,
              unitPrice: "5.00",
              totalValue: "10.00",
              priceSource: "triff",
            },
          ],
          // Deliberately wrong: the sum of items[].totalValue is 10.00, not
          // 999.00. A caller must not be able to make the persisted pool
          // total disagree with the rows that back it.
          totalValue: "999.00",
          dropped: [],
        },
      }),
    );
    const [pool] = await ctx.db.select().from(lootPool).where(eq(lootPool.id, poolId));
    expect(pool.totalValue).toBe("10.00");
    expect(await soleParticipantAmount(operationId)).toBe("10.00");
  });
});

describe("addFlatPool", () => {
  it("requires a note", async () => {
    const { operatorId, operationId } = await seedOperation();
    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, operatorId, operationId, { totalValue: "500.00", notes: "" }),
      ),
    ).rejects.toThrow(/note/);
  });

  it("rejects a malformed totalValue before it can reach the database", async () => {
    const { operatorId, operationId } = await seedOperation();
    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, operatorId, operationId, {
          totalValue: "not-a-number",
          notes: "note",
        }),
      ),
    ).rejects.toThrow(/not a valid ISK amount/);
  });

  it("rejects a negative totalValue with a domain error rather than a raw DB constraint failure", async () => {
    const { operatorId, operationId } = await seedOperation();
    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, operatorId, operationId, {
          totalValue: "-500.00",
          notes: "note",
        }),
      ),
    ).rejects.toThrow(/cannot be negative/);
  });

  it("rejects requirePayoutOperator before the note check, so a forbidden actor sees the authorization error first", async () => {
    const { operationId } = await seedOperation();
    const green = await seedAccount(ctx.db, { tier: "green", status: "active" });
    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, green.id, operationId, { totalValue: "1.00", notes: "" }),
      ),
    ).rejects.toThrow(PayoutForbiddenError);
  });

  it("sums with an appraised pool into the operation total", async () => {
    const { operatorId, operationId } = await seedOperation();
    await ctx.db.transaction((tx) =>
      addAppraisedPool(tx, operatorId, operationId, {
        rawPaste: "1x Tritanium",
        pricingMode: "sell_best",
        stationId: 60003760,
        appraisal: {
          items: [
            {
              typeId: 34,
              name: "Tritanium",
              qty: 1,
              unitPrice: "100.00",
              totalValue: "100.00",
              priceSource: "triff",
            },
          ],
          totalValue: "100.00",
          dropped: [],
        },
      }),
    );
    await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, {
        totalValue: "50.00",
        notes: "capital sold privately",
      }),
    );
    const pools = await ctx.db
      .select()
      .from(lootPool)
      .where(eq(lootPool.operationId, operationId));
    expect(pools).toHaveLength(2);
    expect(await soleParticipantAmount(operationId)).toBe("150.00");
  });
});

describe("deletePool", () => {
  it("triggers recalculation, taking its value back out of the total", async () => {
    const { operatorId, operationId } = await seedOperation();
    const { poolId } = await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, { totalValue: "200.00", notes: "note" }),
    );
    expect(await soleParticipantAmount(operationId)).toBe("200.00");

    await ctx.db.transaction((tx) => deletePool(tx, operatorId, poolId));
    expect(await soleParticipantAmount(operationId)).toBe("0.00");
    expect(
      await ctx.db.select().from(lootPool).where(eq(lootPool.id, poolId)),
    ).toHaveLength(0);
  });

  /**
   * pool.operationId is immutable, so locking on it is safe regardless of
   * ordering, but two concurrent deletes of the SAME pool both read the pool
   * row before either takes the lock. Without a re-read after the lock, the
   * loser would still delete zero rows and log its own payout.pool_deleted
   * audit entry — a duplicate, misleading trail for an action that only
   * happened once.
   *
   * True concurrency between two `Promise.allSettled`-launched transactions is
   * not by itself a reliable way to hit this exact window (whichever call
   * happens to finish its own initial select first can race the other's
   * entirely, well before either reaches the lock). To make the interleaving
   * deterministic, an external "blocker" transaction takes the operation lock
   * first, so both deletePool calls are guaranteed to complete their initial
   * pool lookup (finding the row) and then queue on lockOperation before
   * either can proceed — reproducing the TOCTOU window itself rather than
   * hoping for it.
   */
  it("two concurrent deletes of the same pool log exactly one audit entry", async () => {
    const { operatorId, operationId } = await seedOperation();
    const { poolId } = await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, { totalValue: "200.00", notes: "note" }),
    );

    let releaseBlocker!: () => void;
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerDone!: Promise<void>;
    const blockerHasLock = new Promise<void>((resolve) => {
      blockerDone = ctx.db.transaction(async (tx) => {
        await tx
          .select()
          .from(payoutOperation)
          .where(eq(payoutOperation.id, operationId))
          .for("update");
        resolve();
        await blockerReleased;
      });
    });
    await blockerHasLock;

    const attempt1 = ctx.db.transaction((tx) => deletePool(tx, operatorId, poolId));
    const attempt2 = ctx.db.transaction((tx) => deletePool(tx, operatorId, poolId));
    // Wait for both attempts to actually be queued on lockOperation, rather
    // than sleeping a fixed 100ms and hoping. A sleep that is long enough on
    // a developer machine is not necessarily long enough on a loaded CI box,
    // and when it is too short the test does not fail — it silently stops
    // testing serialization and passes for the wrong reason.
    await waitForLockWaiters(2);
    releaseBlocker();
    // Wait for the blocker's own transaction to actually commit and release
    // the row lock, rather than relying on the next test's beforeEach
    // TRUNCATE to incidentally block on it -- a failure inside the blocker
    // would otherwise surface as an unhandled rejection instead of failing
    // this test.
    await blockerDone;

    const results = await Promise.allSettled([attempt1, attempt2]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);

    const deletedEvents = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "payout.pool_deleted"));
    expect(deletedEvents).toHaveLength(1);
  });
});

describe("payment lock", () => {
  it("rejects adding a pool once the operation has a payment", async () => {
    const { operatorId, operationId } = await seedOperation();
    await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, { totalValue: "100.00", notes: "note" }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operatorId, operationId));
    const [participant] = await ctx.db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId));
    await ctx.db.transaction((tx) => recordPayment(tx, operatorId, participant.id));

    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, operatorId, operationId, {
          totalValue: "999.00",
          notes: "too late",
        }),
      ),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("rejects adding or deleting a pool once the operation is finalized", async () => {
    const { operatorId, operationId } = await seedOperation();
    const { poolId } = await ctx.db.transaction((tx) =>
      addFlatPool(tx, operatorId, operationId, { totalValue: "100.00", notes: "note" }),
    );
    await ctx.db.transaction((tx) => finalizeOperation(tx, operatorId, operationId));

    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, operatorId, operationId, { totalValue: "50.00", notes: "late" }),
      ),
    ).rejects.toThrow(PayoutLockedError);
    await expect(
      ctx.db.transaction((tx) => deletePool(tx, operatorId, poolId)),
    ).rejects.toThrow(PayoutLockedError);
  });

  it("rejects a non-operator actor at the service layer, not just in the action", async () => {
    const { operationId } = await seedOperation();
    const green = await seedAccount(ctx.db, { tier: "green", status: "active" });
    await expect(
      ctx.db.transaction((tx) =>
        addFlatPool(tx, green.id, operationId, { totalValue: "1.00", notes: "n" }),
      ),
    ).rejects.toThrow(PayoutForbiddenError);
  });
});

describe("loot_item CHECK constraints", () => {
  it("rejects a non-positive qty at the database level (loot_item_qty_ck)", async () => {
    const { operatorId, operationId } = await seedOperation();
    await expectCheckViolation(
      ctx.db.transaction((tx) =>
        addAppraisedPool(tx, operatorId, operationId, {
          rawPaste: "0x Broken",
          pricingMode: "sell_best",
          stationId: 60003760,
          appraisal: {
            items: [
              {
                typeId: 34,
                name: "Broken",
                qty: 0,
                unitPrice: "1.00",
                totalValue: "0.00",
                priceSource: "triff",
              },
            ],
            totalValue: "0.00",
            dropped: [],
          },
        }),
      ),
      "loot_item_qty_ck",
    );
  });

  it("rejects a negative unit price at the database level (loot_item_price_ck)", async () => {
    const { operatorId, operationId } = await seedOperation();
    await expectCheckViolation(
      ctx.db.transaction((tx) =>
        addAppraisedPool(tx, operatorId, operationId, {
          rawPaste: "1x Broken",
          pricingMode: "sell_best",
          stationId: 60003760,
          appraisal: {
            items: [
              {
                typeId: 34,
                name: "Broken",
                qty: 1,
                unitPrice: "-1.00",
                totalValue: "0.00",
                priceSource: "triff",
              },
            ],
            totalValue: "0.00",
            dropped: [],
          },
        }),
      ),
      "loot_item_price_ck",
    );
  });
});
