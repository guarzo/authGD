import { desc } from "drizzle-orm";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { createProgressNotifier } from "@/lib/healthcheck-progress";
import { syncRun } from "@/db/schema";
import { JobRetryError, runJob, type JobResult } from "@/services/sync-run";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

async function latestRun() {
  const rows = await ctx.db.select().from(syncRun).orderBy(desc(syncRun.id)).limit(1);
  return rows[0];
}

describe("runJob", () => {
  it("records an ok run with counts", async () => {
    await runJob(ctx.db, "membership", async () => ({
      status: "ok",
      counts: { resolved: 3 },
    }));
    const run = await latestRun();
    expect(run.jobType).toBe("membership");
    expect(run.status).toBe("ok");
    expect(run.finishedAt).not.toBeNull();
    expect(run.counts).toEqual({ resolved: 3 });
  });

  it("records failed and rethrows on unexpected errors", async () => {
    await expect(
      runJob(ctx.db, "contacts", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const run = await latestRun();
    expect(run.status).toBe("failed");
    expect(run.errorSummary).toContain("boom");
  });

  it("records the result then throws JobRetryError when retry is requested", async () => {
    await expect(
      runJob(ctx.db, "wanderer", async () => ({
        status: "partial",
        errorSummary: "2 transient failures",
        retry: true,
      })),
    ).rejects.toBeInstanceOf(JobRetryError);
    const run = await latestRun();
    expect(run.status).toBe("partial");
    expect(run.errorSummary).toBe("2 transient failures");
  });

  it("records failed WITHOUT throwing for permanent-config results", async () => {
    const result = await runJob(ctx.db, "discord-roles", async () => ({
      status: "failed",
      errorSummary: "managed role ids are not distinct",
    }));
    expect(result.status).toBe("failed");
    const run = await latestRun();
    expect(run.status).toBe("failed");
  });
});

// A narrow DB boundary records when the terminal write actually settles.
// Missing/early notifications and notifications on failed writes are observable.
function recordingDb(fail?: "start" | "finish") {
  const writeError = new Error("database write failed");
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: () => ({
        returning: async () => {
          if (fail === "start") throw writeError;
          return [{ id: 1 }];
        },
      }),
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => ({
        where: async () => {
          if (fail === "finish") throw writeError;
          rows.push(row);
        },
      }),
    }),
  } as unknown as Db;
  return { db, rows, writeError };
}

describe("runJob progress boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["ok", "partial", "failed", "retry", "exception"] as const)(
    "notifies exactly once after a persisted %s result",
    async (outcome) => {
      const { db, rows } = recordingDb();
      const original = new Error("original job failure");
      const status =
        outcome === "exception" ? "failed" : outcome === "retry" ? "partial" : outcome;
      const result: JobResult = {
        status,
        ...(outcome === "retry" ? { retry: true } : {}),
      };
      const notifiedRows: Array<Record<string, unknown>> = [];
      const notify = vi.fn(() => {
        expect(rows).toHaveLength(1);
        notifiedRows.push({ ...rows[0] });
      });
      const work = runJob(
        db,
        "contacts",
        async () => {
          if (outcome === "exception") throw original;
          return result;
        },
        notify,
      );
      if (outcome === "exception") await expect(work).rejects.toBe(original);
      else if (outcome === "retry")
        await expect(work).rejects.toBeInstanceOf(JobRetryError);
      else await expect(work).resolves.toBe(result);
      expect(notify).toHaveBeenCalledOnce();
      expect(notifiedRows).toEqual([
        expect.objectContaining({ status, finishedAt: expect.any(Date) }),
      ]);
    },
  );

  it.each(["start", "finish"] as const)(
    "does not notify when the %s write fails",
    async (stage) => {
      const { db, writeError } = recordingDb(stage);
      const notify = vi.fn();
      await expect(
        runJob(db, "contacts", async () => ({ status: "ok" }), notify),
      ).rejects.toBe(writeError);
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it("does not notify when recording an unexpected job failure fails", async () => {
    const { db, writeError } = recordingDb("finish");
    const notify = vi.fn();
    await expect(
      runJob(
        db,
        "contacts",
        async () => {
          throw new Error("job failed");
        },
        notify,
      ),
    ).rejects.toBe(writeError);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "contains synchronous notification failure (job throws=%s)",
    async (throws) => {
      const { db, rows } = recordingDb();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const original = new Error("original job failure");
      const notify = () => {
        throw new Error("secret monitor URL");
      };
      const work = runJob(
        db,
        "contacts",
        async () => {
          if (throws) throw original;
          return { status: "ok" };
        },
        notify,
      );
      if (throws) await expect(work).rejects.toBe(original);
      else await expect(work).resolves.toEqual({ status: "ok" });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(throws ? "failed" : "ok");
      expect(log.mock.calls).toEqual([["sync completion notification failed"]]);
    },
  );

  it.each([false, true])(
    "does not wait for HTTP delivery or change an error (job throws=%s)",
    async (throws) => {
      const { db } = recordingDb();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      let rejectDelivery!: (error: Error) => void;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            rejectDelivery = reject;
          }),
      );
      const notify = createProgressNotifier(
        { syncMode: "live", healthcheckProgressUrl: "https://monitor.example/secret" },
        fetchImpl,
      );
      const original = new Error("original failure");
      const work = runJob(
        db,
        "contacts",
        async () => {
          if (throws) throw original;
          return { status: "ok" };
        },
        notify,
      );
      if (throws) await expect(work).rejects.toBe(original);
      else await expect(work).resolves.toEqual({ status: "ok" });
      expect(fetchImpl).toHaveBeenCalledOnce();
      rejectDelivery(new Error("https://monitor.example/secret"));
      await setImmediate();
      expect(log.mock.calls).toEqual([["sync progress ping failed"]]);
    },
  );
});
