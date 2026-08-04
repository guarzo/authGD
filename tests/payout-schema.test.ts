import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lootPool, payoutOperation, payoutParticipant } from "@/db/schema";
import { setupTestDb, truncateAll } from "./helpers/db";
import { expectCheckViolation } from "./helpers/constraints";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("payout schema", () => {
  it("creates an operation, a pool, and a participant with defaults", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Thursday roam", occurredAt: new Date() })
      .returning();
    expect(op.status).toBe("draft");
    expect(op.corpSharePct).toBe("0.00");

    const [pool] = await ctx.db
      .insert(lootPool)
      .values({
        operationId: op.id,
        valuationSource: "flat",
        totalValue: "1000.00",
        notes: "sold privately",
      })
      .returning();
    expect(pool.totalValue).toBe("1000.00");

    const [participant] = await ctx.db
      .insert(payoutParticipant)
      .values({ operationId: op.id, displayName: "Some Pilot" })
      .returning();
    expect(participant.shares).toBe("1.00");
    expect(participant.excluded).toBe(false);
    expect(participant.paidAmount).toBeNull();
  });

  it("rejects a negative share count", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    await expectCheckViolation(
      ctx.db
        .insert(payoutParticipant)
        .values({ operationId: op.id, displayName: "Bad Share", shares: "-1" }),
      "payout_participant_shares_ck",
    );
  });

  it("rejects a corpSharePct over 100", async () => {
    await expectCheckViolation(
      ctx.db
        .insert(payoutOperation)
        .values({ name: "Op", occurredAt: new Date(), corpSharePct: "101" }),
      "payout_operation_corp_pct_ck",
    );
  });

  it("rejects a flat pool with no note", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    await expectCheckViolation(
      ctx.db.insert(lootPool).values({
        operationId: op.id,
        valuationSource: "flat",
        totalValue: "500.00",
      }),
      "loot_pool_flat_note_ck",
    );
  });

  it("rejects an appraised pool with both stationId and regionId set", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    await expectCheckViolation(
      ctx.db.insert(lootPool).values({
        operationId: op.id,
        valuationSource: "appraised",
        pricingMode: "sell_best",
        stationId: 60003760,
        regionId: 10000002,
        totalValue: "500.00",
      }),
      "loot_pool_appraised_fields_ck",
    );
  });

  it("rejects an appraised pool with neither stationId nor regionId set", async () => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date() })
      .returning();
    await expectCheckViolation(
      ctx.db.insert(lootPool).values({
        operationId: op.id,
        valuationSource: "appraised",
        pricingMode: "sell_best",
        totalValue: "500.00",
      }),
      "loot_pool_appraised_fields_ck",
    );
  });
});
