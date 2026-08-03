import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, wandererAclObservation } from "@/db/schema";
import { runWandererJob } from "@/jobs/wanderer";
import {
  ACL_GRANT_ROLE,
  WandererError,
  type WandererAclMember,
  type WandererClient,
} from "@/lib/wanderer/client";
import { JobRetryError } from "@/services/sync-run";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

type Member = WandererAclMember;

/** Fake Wanderer with a mutable member list and scriptable failures. */
function fakeWanderer(initial: Member[], opts: {
  failFirstRead?: boolean;
  /** Initial read failure is permanent (e.g. rotated API key), not transient. */
  permanentFirstReadFailure?: boolean;
  failReRead?: boolean;
  failRemoveOf?: number;
  /** When set with failRemoveOf, the remove failure is permanent (transient: false). */
  permanentRemoveFailure?: boolean;
} = {}) {
  let members = [...initial];
  let reads = 0;
  const client: WandererClient = {
    getAclMembers: async () => {
      reads++;
      if (opts.failFirstRead && reads === 1) {
        throw new WandererError("read failed", { status: 502, transient: true });
      }
      if (opts.permanentFirstReadFailure && reads === 1) {
        throw new WandererError("read failed", { status: 401, transient: false });
      }
      if (opts.failReRead && reads > 1) {
        throw new WandererError("re-read failed", { status: 502, transient: true });
      }
      return [...members];
    },
    addAclMember: async (id) => {
      members.push({ characterId: id, role: "viewer" });
    },
    updateAclMemberRole: async (id, role) => {
      members = members.map((m) => (m.characterId === id ? { ...m, role } : m));
    },
    removeAclMember: async (id) => {
      if (opts.failRemoveOf === id) {
        throw new WandererError("remove failed", {
          status: opts.permanentRemoveFailure ? 400 : 500,
          transient: !opts.permanentRemoveFailure,
        });
      }
      members = members.filter((m) => m.characterId !== id);
    },
  };
  return { client, members: () => members, reads: () => reads };
}

async function seedFlygdChar(id: number) {
  const acc = await seedAccount(ctx.db, { tier: "flygd" });
  await seedCharacter(ctx.db, cfg, { id, accountId: acc.id, main: true });
}

describe("runWandererJob", () => {
  it("adds desired, removes undesired (never admins), persists the POST-mutation read", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([
      { characterId: 2, role: "member" },
      { characterId: 3, role: "admin" },
      { characterId: 4, role: "manager" },
      { characterId: null, role: "viewer" }, // corp/alliance entry — never touched
    ]);
    const result = await runWandererJob({ db: ctx.db, cfg, wanderer: w.client });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ added: 1, removed: 2 });
    expect(w.reads()).toBe(2); // initial + post-mutation
    // corp/alliance entry survived untouched…
    expect(w.members().some((m) => m.characterId === null)).toBe(true);
    // …and the observation holds only character entries
    const observed = await ctx.db.select().from(wandererAclObservation);
    expect(observed.map((o) => [o.characterId, o.role]).sort()).toEqual([
      [1, "viewer"],
      [3, "admin"],
    ]);
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.filter((a) => a.action === "wanderer.removed")).toHaveLength(2);
    expect(audits.filter((a) => a.action === "wanderer.added")).toHaveLength(1);
  });

  it("aborts before ANY mutation when the initial read fails", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([{ characterId: 2, role: "member" }], { failFirstRead: true });
    await expect(
      runWandererJob({ db: ctx.db, cfg, wanderer: w.client }),
    ).rejects.toBeInstanceOf(JobRetryError);
    expect(w.members()).toEqual([{ characterId: 2, role: "member" }]); // untouched
    expect(await ctx.db.select().from(wandererAclObservation)).toEqual([]);
  });

  it("alerts the ops webhook on a PERMANENT initial read failure (e.g. rotated API key)", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([{ characterId: 2, role: "member" }], {
      permanentFirstReadFailure: true,
    });
    const webhook = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }));
    const result = await runWandererJob({
      db: ctx.db,
      cfg,
      wanderer: w.client,
      fetchImpl: webhook as unknown as typeof fetch,
    });
    // returned, not thrown: a permanent read failure must not retry-loop —
    // but pg-boss would otherwise see success and never dead-letter it, so
    // the ops webhook is the only alert path.
    expect(result.status).toBe("failed");
    expect(result.retry).toBeUndefined();
    expect(webhook).toHaveBeenCalledOnce();
    const [, init] = webhook.mock.calls[0];
    expect(JSON.parse(init.body as string).content).toContain("wanderer");
  });

  it("does NOT alert the ops webhook on a transient initial read failure", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([{ characterId: 2, role: "member" }], { failFirstRead: true });
    const webhook = vi.fn(async () => new Response("", { status: 200 }));
    await expect(
      runWandererJob({
        db: ctx.db,
        cfg,
        wanderer: w.client,
        fetchImpl: webhook as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(JobRetryError);
    expect(webhook).not.toHaveBeenCalled();
  });

  it("persists the initial read as the observation when nothing needs mutating", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([{ characterId: 1, role: "member" }]);
    await runWandererJob({ db: ctx.db, cfg, wanderer: w.client });
    expect(w.reads()).toBe(1);
    const observed = await ctx.db.select().from(wandererAclObservation);
    expect(observed).toHaveLength(1);
    expect(observed[0].characterId).toBe(1);
  });

  it("still re-reads and persists after a partial mutation failure, then retries", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer(
      [
        { characterId: 2, role: "member" },
        { characterId: 5, role: "member" },
      ],
      { failRemoveOf: 5 },
    );
    await expect(
      runWandererJob({ db: ctx.db, cfg, wanderer: w.client }),
    ).rejects.toBeInstanceOf(JobRetryError);
    const observed = await ctx.db.select().from(wandererAclObservation);
    // 5's removal failed, so the post-mutation read still contains it — and
    // the observation reflects that reality, not the desired state.
    expect(observed.map((o) => o.characterId).sort((a, b) => a - b)).toEqual([1, 5]);
  });

  it("unblocks a desired blocked member and observes the new role", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer([{ characterId: 1, role: "blocked" }]);
    const result = await runWandererJob({ db: ctx.db, cfg, wanderer: w.client });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ unblocked: 1, added: 0, removed: 0 });
    const observed = await ctx.db.select().from(wandererAclObservation);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ characterId: 1, role: ACL_GRANT_ROLE });
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "wanderer.unblocked")).toBe(true);
  });

  it("does NOT retry when every failure was permanent", async () => {
    await seedFlygdChar(1);
    const w = fakeWanderer(
      [
        { characterId: 1, role: "viewer" },
        { characterId: 5, role: "member" },
      ],
      { failRemoveOf: 5, permanentRemoveFailure: true },
    );
    // returned, not thrown: permanent failures must not retry-loop
    const result = await runWandererJob({ db: ctx.db, cfg, wanderer: w.client });
    expect(result.status).toBe("partial");
    expect(result.retry).toBeUndefined();
  });

  it("leaves the previous observation untouched when the re-read fails", async () => {
    await seedFlygdChar(1);
    await ctx.db.insert(wandererAclObservation).values({
      characterId: 42,
      role: "member",
      observedAt: new Date(),
    });
    const w = fakeWanderer([{ characterId: 2, role: "member" }], { failReRead: true });
    await expect(
      runWandererJob({ db: ctx.db, cfg, wanderer: w.client }),
    ).rejects.toBeInstanceOf(JobRetryError);
    const observed = await ctx.db.select().from(wandererAclObservation);
    expect(observed.map((o) => o.characterId)).toEqual([42]); // stale but honest
  });
});
