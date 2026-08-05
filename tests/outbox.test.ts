import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outbox } from "@/db/schema";
import {
  enqueueSync,
  markDispatched,
  takeUndispatched,
  undispatchedSummary,
} from "@/services/outbox";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

describe("outbox", () => {
  it("enqueues, takes, and marks dispatched", async () => {
    await enqueueSync(ctx.db, { kind: "all" });
    await enqueueSync(ctx.db, {
      kind: "account",
      accountId: "00000000-0000-0000-0000-000000000001",
    });

    const taken = await takeUndispatched(ctx.db);
    expect(taken).toHaveLength(2);

    await markDispatched(
      ctx.db,
      taken.map((t) => t.id),
    );
    expect(await takeUndispatched(ctx.db)).toHaveLength(0);
  });

  describe("undispatchedSummary", () => {
    it("collapses repeated payloads into one row instead of growing with the backlog", async () => {
      // Three "all" rows (as a stuck worker would accumulate every scheduler
      // tick) must not appear as three rows: the consumer only needs the
      // distinct set of payloads, and an ungrouped read would grow without
      // bound for exactly as long as the worker is down.
      await enqueueSync(ctx.db, { kind: "all" });
      await enqueueSync(ctx.db, { kind: "all" });
      await enqueueSync(ctx.db, { kind: "all" });
      await enqueueSync(ctx.db, { kind: "membership-recheck" });

      const summary = await undispatchedSummary(ctx.db);
      expect(summary).toHaveLength(2);
      expect(summary.map((r) => r.payload.kind).sort()).toEqual([
        "all",
        "membership-recheck",
      ]);
      for (const row of summary) {
        expect(row.oldest).toBeInstanceOf(Date);
      }
    });

    it("returns the oldest createdAt per payload, not the newest", async () => {
      await ctx.db
        .insert(outbox)
        .values({ payload: { kind: "all" }, createdAt: new Date(2000, 0, 1) });
      await ctx.db
        .insert(outbox)
        .values({ payload: { kind: "all" }, createdAt: new Date(2020, 0, 1) });
      const summary = await undispatchedSummary(ctx.db);
      expect(summary).toHaveLength(1);
      expect(summary[0].oldest).toEqual(new Date(2000, 0, 1));
    });

    it("excludes already-dispatched rows", async () => {
      await enqueueSync(ctx.db, { kind: "all" });
      const taken = await takeUndispatched(ctx.db);
      await markDispatched(
        ctx.db,
        taken.map((t) => t.id),
      );
      expect(await undispatchedSummary(ctx.db)).toEqual([]);
    });
  });
});
