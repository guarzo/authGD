import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
} from "@/db/schema";
import { runAccessListsJob } from "@/jobs/access-lists";
import {
  ACCESS_LISTS_SCOPE,
  EsiError,
  type AccessListsEsi,
  type EsiAccessList,
} from "@/lib/esi/client";
import { JobRetryError } from "@/services/sync-run";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const HOLDER = 1000;

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

/** A refresh that always succeeds, rotating to a new blob. */
const okToken = (async () =>
  new Response(JSON.stringify({ access_token: "at", refresh_token: "rt2" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

/** A refresh EVE permanently rejects → getFreshAccessToken returns "invalid". */
const deadToken = (async () =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

/** A refresh that 500s → getFreshAccessToken returns "transient". */
const flakyToken = (async () =>
  new Response("upstream boom", { status: 500 })) as typeof fetch;

const list = (id: number, over: Partial<EsiAccessList> = {}): EsiAccessList => ({
  id,
  name: `List ${id}`,
  description: "",
  allowEveryone: false,
  characters: [],
  corporations: [],
  alliances: [],
  ...over,
});

type Calls = { lists: number; details: number[] };

function fakeEsi(opts: {
  ids?: number[];
  detail?: Record<number, EsiAccessList | EsiError>;
  listsError?: EsiError;
}): { esi: AccessListsEsi; calls: Calls } {
  const calls: Calls = { lists: 0, details: [] };
  const esi: AccessListsEsi = {
    getAccessLists: async () => {
      calls.lists++;
      if (opts.listsError) throw opts.listsError;
      return opts.ids ?? [];
    },
    getAccessList: async (_characterId, accessListId) => {
      calls.details.push(accessListId);
      const d = opts.detail?.[accessListId];
      if (d instanceof EsiError) throw d;
      return d ?? list(accessListId);
    },
    getUniverseNames: async (ids) =>
      ids.map((id) => ({ id, name: `Name ${id}`, category: "character" })),
  };
  return { esi, calls };
}

/** Seeds a healthy designated holder and returns its character id. */
async function seedHolder(opts: { scopes?: string[] } = {}): Promise<number> {
  const acc = await seedAccount(ctx.db, { tier: "member" });
  await seedCharacter(ctx.db, cfg, {
    id: HOLDER,
    accountId: acc.id,
    main: true,
    scopes: opts.scopes ?? [...cfg.eveSso.scopes, ACCESS_LISTS_SCOPE],
  });
  await ctx.db
    .insert(accessListHolder)
    .values({ id: 1, characterId: HOLDER, designatedBy: "admin" });
  return HOLDER;
}

async function watch(accessListId: number): Promise<void> {
  await ctx.db.insert(accessListWatch).values({ accessListId, addedBy: "admin" });
}

async function snapshotOf(accessListId: number) {
  const [row] = await ctx.db
    .select()
    .from(accessListSnapshot)
    .where(eq(accessListSnapshot.accessListId, accessListId));
  return row;
}

async function entriesOf(accessListId: number) {
  return ctx.db
    .select()
    .from(accessListEntry)
    .where(eq(accessListEntry.accessListId, accessListId));
}

describe("runAccessListsJob", () => {
  it("no holder designated is ok, not a failure", async () => {
    const { esi, calls } = fakeEsi({});
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    // An unconfigured optional feature must not paint /admin/sync red.
    expect(result.status).toBe("ok");
    expect(result.counts?.noHolder).toBe(1);
    expect(calls.lists).toBe(0);
  });

  it("a holder missing the scope is ok, and costs no ESI call", async () => {
    await seedHolder({ scopes: [...cfg.eveSso.scopes] });
    const { esi, calls } = fakeEsi({ ids: [7] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("ok");
    expect(result.counts?.scopeMissing).toBe(1);
    // Calling anyway would spend a token rotation to earn a certain 403.
    expect(calls.lists).toBe(0);
  });

  it("dry-run skips: getFreshAccessToken refuses before any refresh", async () => {
    await seedHolder();
    const dryCfg = testConfig({ SYNC_MODE: "dry-run" });
    const { esi, calls } = fakeEsi({ ids: [7] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg: dryCfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("ok");
    expect(result.counts?.skipped).toBe(1);
    expect(calls.lists).toBe(0);
  });

  it("a transient token failure retries", async () => {
    await seedHolder();
    const { esi } = fakeEsi({ ids: [7] });
    await expect(
      runAccessListsJob({ db: ctx.db, cfg, esi, fetchImpl: flakyToken }),
    ).rejects.toThrow(JobRetryError);
  });

  it("no stored token fails without retrying", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: HOLDER,
      accountId: acc.id,
      main: true,
      refreshToken: null,
      scopes: [...cfg.eveSso.scopes, ACCESS_LISTS_SCOPE],
    });
    await ctx.db
      .insert(accessListHolder)
      .values({ id: 1, characterId: HOLDER, designatedBy: "admin" });
    const { esi } = fakeEsi({ ids: [7] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("failed");
    expect(result.retry).toBeUndefined();
  });

  it("a permanently rejected token fails without retrying", async () => {
    await seedHolder();
    const { esi } = fakeEsi({ ids: [7] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: deadToken,
    });
    expect(result.status).toBe("failed");
    expect(result.retry).toBeUndefined();
  });

  it("reconciles the catalog, naming only the ids it has not cached", async () => {
    await seedHolder();
    await watch(7);
    // 999 is stale — the holder can no longer see it, so it must go. 8 is
    // already cached, so it must NOT cost a second detail call.
    await ctx.db.insert(accessListCatalog).values([
      { accessListId: 999, name: "Gone", observedByCharacterId: HOLDER },
      { accessListId: 8, name: "Cached", observedByCharacterId: HOLDER },
    ]);
    const { esi, calls } = fakeEsi({
      ids: [7, 8],
      detail: {
        7: list(7, {
          name: "Fleet",
          characters: [{ access: "read", id: 42 }],
          corporations: [{ access: "read", id: 900 }],
        }),
      },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ lists: 2, watched: 1, read: 1, failed: 0 });
    const catalog = await ctx.db.select().from(accessListCatalog);
    expect(catalog.map((r) => [r.accessListId, r.name]).sort()).toEqual([
      [7, "Fleet"],
      [8, "Cached"],
    ]);
    // 7 was uncached AND watched, so it is named by discovery and then read;
    // 8 was cached, so it costs nothing. `named` counts only the naming call.
    expect(result.counts?.named).toBe(1);
    expect(calls.details).toEqual([7, 7]);
    const snap = await snapshotOf(7);
    expect(snap.readStatus).toBe("ok");
    expect(snap.name).toBe("Fleet");
    expect(snap.observedAt).not.toBeNull();
    const entries = await entriesOf(7);
    expect(entries.map((e) => [e.kind, e.entityId, e.access]).sort()).toEqual([
      ["character", 42, "read"],
      ["corporation", 900, "read"],
    ]);
  });

  it("leaves an unnameable list out of the catalog rather than inserting a placeholder", async () => {
    await seedHolder();
    const { esi } = fakeEsi({
      ids: [7],
      detail: { 7: new EsiError("boom", 500, "transient") },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    // `name` is NOT NULL and a "?" row in the picker is worse than no row.
    expect(await ctx.db.select().from(accessListCatalog)).toEqual([]);
    expect(result.counts?.named).toBe(0);
  });

  it("a failed read leaves the prior entries intact and moves only lastAttemptAt", async () => {
    await seedHolder();
    await watch(7);
    const first = fakeEsi({
      ids: [7],
      detail: { 7: list(7, { characters: [{ access: "read", id: 42 }] }) },
    });
    await runAccessListsJob({ db: ctx.db, cfg, esi: first.esi, fetchImpl: okToken });
    const before = await snapshotOf(7);
    expect(before.observedAt).not.toBeNull();

    const second = fakeEsi({
      ids: [7],
      detail: { 7: new EsiError("boom", 500, "transient") },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi: second.esi,
      fetchImpl: okToken,
    });
    expect(result.counts?.failed).toBe(1);
    // Never remove on unknown state (src/jobs/wanderer.ts:41-54): a wiped
    // snapshot renders as "everyone lost access".
    const entries = await entriesOf(7);
    expect(entries.map((e) => e.entityId)).toEqual([42]);
    const after = await snapshotOf(7);
    // Two timestamps, never collapsed.
    expect(after.observedAt?.getTime()).toBe(before.observedAt?.getTime());
    expect(after.lastAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before.lastAttemptAt.getTime(),
    );
    expect(after.readStatus).toBe("failed");
    expect(after.detail).toContain("boom");
  });

  it("a 403 is not_visible, not a token fault", async () => {
    await seedHolder();
    await watch(7);
    const { esi } = fakeEsi({
      ids: [7],
      detail: { 7: new EsiError("forbidden", 403, "permanent") },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    // A list the holder simply cannot see is a normal state, not an error.
    expect(result.status).toBe("partial");
    const snap = await snapshotOf(7);
    expect(snap.readStatus).toBe("not_visible");
    expect(snap.observedAt).toBeNull();
  });

  it("a watched list discovery did not return is not_visible, with no detail call", async () => {
    await seedHolder();
    await watch(7);
    // Seed a good read first, so the test can prove the skip preserves it.
    const first = fakeEsi({
      ids: [7],
      detail: { 7: list(7, { characters: [{ access: "read", id: 42 }] }) },
    });
    await runAccessListsJob({ db: ctx.db, cfg, esi: first.esi, fetchImpl: okToken });
    const before = await snapshotOf(7);

    // The holder loses the list: discovery no longer returns it.
    const second = fakeEsi({ ids: [] });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi: second.esi,
      fetchImpl: okToken,
    });

    expect(result.status).toBe("partial");
    // The point of the skip: no detail fetch at all. A 200 with empty
    // membership would otherwise be written as a real observation and wipe
    // the entries below.
    expect(second.calls.details).toEqual([]);
    const after = await snapshotOf(7);
    expect(after.readStatus).toBe("not_visible");
    expect(after.observedAt?.getTime()).toBe(before.observedAt?.getTime());
    expect((await entriesOf(7)).map((e) => e.entityId)).toEqual([42]);
  });

  it("discards the write when the holder changed mid-run", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 2000,
      accountId: acc.id,
      scopes: [...cfg.eveSso.scopes, ACCESS_LISTS_SCOPE],
    });
    await seedHolder();
    await watch(7);
    const { esi } = fakeEsi({ ids: [7, 8] });
    // Re-designate between the read and the write: getAccessLists is the last
    // point the job still believes HOLDER is designated.
    const racing: AccessListsEsi = {
      ...esi,
      getAccessLists: async (characterId, token) => {
        const ids = await esi.getAccessLists(characterId, token);
        await ctx.db
          .update(accessListHolder)
          .set({ characterId: 2000, designatedAt: new Date() })
          .where(eq(accessListHolder.id, 1));
        return ids;
      },
    };
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi: racing,
      fetchImpl: okToken,
    });
    // Outbox execution is at-least-once (src/worker/dispatcher.ts:124-136), so
    // a run started under holder A can land after B was designated. Different
    // holders see different lists — this is a discard, not a merge.
    expect(result.status).toBe("ok");
    expect(result.counts?.holderChanged).toBe(1);
    expect(await ctx.db.select().from(accessListCatalog)).toEqual([]);
  });

  it("resolves names for the ids it observed", async () => {
    await seedHolder();
    await watch(7);
    const { esi } = fakeEsi({
      ids: [7],
      detail: {
        7: list(7, {
          characters: [{ access: "read", id: 42 }],
          alliances: [{ access: "read", id: 99000001 }],
        }),
      },
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.counts?.namesResolved).toBe(2);
  });

  it("a transient discovery failure retries, with no reads attempted", async () => {
    await seedHolder();
    await watch(7);
    const { esi, calls } = fakeEsi({
      listsError: new EsiError("boom", 500, "transient"),
    });
    await expect(
      runAccessListsJob({ db: ctx.db, cfg, esi, fetchImpl: okToken }),
    ).rejects.toThrow(JobRetryError);
    expect(calls.details).toEqual([]);
  });

  it("a permanent discovery failure fails without retrying", async () => {
    await seedHolder();
    await watch(7);
    const { esi, calls } = fakeEsi({
      listsError: new EsiError("forbidden", 403, "permanent"),
    });
    const result = await runAccessListsJob({
      db: ctx.db,
      cfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("failed");
    expect(result.retry).toBeUndefined();
    expect(result.errorSummary).toContain("list discovery failed");
    expect(calls.details).toEqual([]);
  });
});
