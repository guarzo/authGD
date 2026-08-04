import { isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outbox } from "@/db/schema";
import { JOB_CRON } from "@/core/schedules";
import { enqueueSync, type OutboxPayload } from "@/services/outbox";
import { dispatchOutbox, planDispatch, RERUNNABLE } from "@/worker/dispatcher";
import { QUEUES } from "@/worker/queues";
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
    expect(
      planDispatch({ kind: "all" })
        .map((p) => p.queue)
        .sort(),
    ).toEqual(["contacts", "discord-roles", "membership", "wanderer"]);
  });

  it("drops an unrecognized kind instead of throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        planDispatch({ kind: "from-the-future" } as unknown as OutboxPayload),
      ).toEqual([]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // `payload` is jsonb NOT NULL, and that does NOT exclude the JSON value
  // `null` — `'null'::jsonb IS NULL` is false, so the column accepts it and the
  // `$type<>()` declaration is a compile-time claim the database never checked.
  // Reading `.kind` off such a row throws, the throw rolls back the whole
  // claim, and `takeUndispatched` orders by id ascending — so one row like this
  // sits at the head of every claim and wedges ALL sync dispatch behind it,
  // permanently. Every shape below has to reach the drop arm instead.
  it.each([
    ["json null", null],
    ["a bare string", "membership"],
    ["a number", 7],
    ["an array", []],
    ["an object with no kind", { accountId: "acc-1" }],
  ])("drops %s rather than throwing and wedging the queue", (_label, payload) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(planDispatch(payload as unknown as OutboxPayload, 42)).toEqual([]);
      // The row id has to reach the log: without it a dropped row and a
      // delivered one are indistinguishable afterwards, because markDispatched
      // stamps both.
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ rowId: 42 }),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ["membership", "membership:all"],
    ["membership-recheck", "membership-recheck:all"],
    ["contacts", "contacts:all"],
    ["wanderer", "wanderer:all"],
    // discord-roles is keyed "roles:all" everywhere else (scheduleJobs, the
    // "all" fan-out); a re-run must reuse it or it double-queues.
    ["discord-roles", "roles:all"],
    ["token-health", "token-health:all"],
    ["purge", "purge:all"],
  ])("maps a job re-run of %s to its queue on %s", (jobType, singletonKey) => {
    expect(planDispatch({ kind: "job", jobType })).toEqual([
      { queue: jobType, data: { jobType }, singletonKey },
    ]);
  });

  // The three places that independently decide what is re-runnable: this
  // allow-list, `Object.hasOwn(JOB_CRON, ...)` in the server action, and the
  // buttons the admin sync page renders off JOB_CRON. The it.each above proves
  // the singleton-key overrides; nothing proved the sets themselves agree, so
  // a JOB_CRON entry with no queue would render a button whose outbox row the
  // drop arm silently discards.
  it("re-runnable queues are exactly the scheduled job types", () => {
    expect([...RERUNNABLE].sort()).toEqual(Object.keys(JOB_CRON).sort());
    // and the ops plumbing stays out of both
    expect(RERUNNABLE.has(QUEUES.deadLetter)).toBe(false);
    expect(Object.hasOwn(JOB_CRON, QUEUES.deadLetter)).toBe(false);
  });

  it.each(["ops-dead-letter", "not-a-queue", "", "membership; DROP"])(
    "refuses to enqueue a job re-run for %j",
    (jobType) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(planDispatch({ kind: "job", jobType })).toEqual([]);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    },
  );

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

  it("drops an unknown-kind row without wedging its siblings in the batch", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await ctx.db
        .insert(outbox)
        .values({ payload: { kind: "from-the-future" } as unknown as OutboxPayload });
      await enqueueSync(ctx.db, { kind: "discord-user", discordUserId: "u9" });
      const { sent, send } = collector();
      // Both rows claimed; the bad one contributes no sends but is still
      // marked dispatched, so it cannot be re-claimed forever.
      expect(await dispatchOutbox(ctx.db, send)).toBe(2);
      expect(sent.map((s) => s.queue)).toEqual(["discord-roles"]);
      const undispatched = await ctx.db
        .select()
        .from(outbox)
        .where(isNull(outbox.dispatchedAt));
      expect(undispatched).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rolls the claim back when a send fails, so rows retry next tick", async () => {
    await enqueueSync(ctx.db, { kind: "all" });
    const failingSend = async () => {
      throw new Error("pg-boss unavailable");
    };
    await expect(dispatchOutbox(ctx.db, failingSend)).rejects.toThrow(
      "pg-boss unavailable",
    );
    const undispatched = await ctx.db
      .select()
      .from(outbox)
      .where(isNull(outbox.dispatchedAt));
    expect(undispatched).toHaveLength(1); // still claimable
  });
});
