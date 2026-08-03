import { isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outbox } from "@/db/schema";
import { enqueueSync } from "@/services/outbox";
import { dispatchOutbox, planDispatch } from "@/worker/dispatcher";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

type Sent = { queue: string; data: Record<string, unknown>; singletonKey: string };
const collector = () => {
  const sent: Sent[] = [];
  const send = async (
    queue: string,
    data: Record<string, unknown>,
    options: { singletonKey: string },
  ) => {
    sent.push({ queue, data, singletonKey: options.singletonKey });
  };
  return { sent, send };
};

describe("planDispatch", () => {
  it("fans an account payload out to scoped membership/roles and GLOBAL contacts/wanderer", () => {
    const plan = planDispatch({ kind: "account", accountId: "acc-1" });
    expect(plan.map((p) => p.queue).sort()).toEqual([
      "contacts",
      "discord-roles",
      "membership",
      "wanderer",
    ]);
    const membership = plan.find((p) => p.queue === "membership");
    expect(membership?.data).toMatchObject({ accountId: "acc-1", jobType: "membership" });
    expect(membership?.singletonKey).toBe("membership:acc-1");
    // desired sets are global — contacts/wanderer coalesce on fixed keys
    expect(plan.find((p) => p.queue === "contacts")?.singletonKey).toBe("contacts:all");
    expect(plan.find((p) => p.queue === "wanderer")?.singletonKey).toBe("wanderer:all");
  });

  it("maps discord-user payloads to a role strip job", () => {
    expect(planDispatch({ kind: "discord-user", discordUserId: "u9" })).toEqual([
      {
        queue: "discord-roles",
        data: { jobType: "discord-roles", discordUserId: "u9" },
        singletonKey: "roles:user:u9",
      },
    ]);
  });

  it("maps 'all' to the four sync queues", () => {
    expect(planDispatch({ kind: "all" }).map((p) => p.queue).sort()).toEqual([
      "contacts",
      "discord-roles",
      "membership",
      "wanderer",
    ]);
  });

  it("maps membership-recheck to the recheck queue with its global singleton key", () => {
    const plan = planDispatch({ kind: "membership-recheck" });
    expect(plan).toEqual([
      {
        queue: "membership-recheck",
        data: { jobType: "membership-recheck" },
        singletonKey: "membership-recheck:all",
      },
    ]);
  });
});

describe("dispatchOutbox", () => {
  it("sends and marks rows dispatched in one pass; second pass is a no-op", async () => {
    await enqueueSync(ctx.db, { kind: "account", accountId: "acc-1" });
    await enqueueSync(ctx.db, { kind: "discord-user", discordUserId: "u9" });
    const { sent, send } = collector();
    expect(await dispatchOutbox(ctx.db, send)).toBe(2);
    expect(sent).toHaveLength(5); // 4 fan-out + 1 role strip
    const undispatched = await ctx.db
      .select()
      .from(outbox)
      .where(isNull(outbox.dispatchedAt));
    expect(undispatched).toEqual([]);
    expect(await dispatchOutbox(ctx.db, send)).toBe(0);
    expect(sent).toHaveLength(5);
  });

  it("rolls the claim back when a send fails, so rows retry next tick", async () => {
    await enqueueSync(ctx.db, { kind: "all" });
    const failingSend = async () => {
      throw new Error("pg-boss unavailable");
    };
    await expect(dispatchOutbox(ctx.db, failingSend)).rejects.toThrow("pg-boss unavailable");
    const undispatched = await ctx.db
      .select()
      .from(outbox)
      .where(isNull(outbox.dispatchedAt));
    expect(undispatched).toHaveLength(1); // still claimable
  });
});
