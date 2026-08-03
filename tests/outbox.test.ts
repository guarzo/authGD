import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueueSync, markDispatched, takeUndispatched } from "@/services/outbox";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

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
});
