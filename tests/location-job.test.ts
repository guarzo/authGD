import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { character, syncRun } from "@/db/schema";
import {
  LOCATION_SCOPE_REQUIRED,
  canReadLocation,
  runLocationJob,
  type LocationEsi,
} from "@/jobs/location";
import { EsiError, type CharacterLocation } from "@/lib/esi/client";
import { JobRetryError } from "@/services/sync-run";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

const ALL_SCOPES = [
  LOCATION_SCOPE_REQUIRED,
  "esi-universe.read_structures.v1",
  "esi-location.read_online.v1",
];

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

const okToken = (async () =>
  new Response(JSON.stringify({ access_token: "at", refresh_token: "rt2" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const inSpace = (systemId: number): CharacterLocation => ({
  systemId,
  stationId: null,
  structureId: null,
});
const docked = (systemId: number, structureId: number): CharacterLocation => ({
  systemId,
  stationId: null,
  structureId,
});

/** Fake ESI: per-character locations, per-structure names; records online reads. */
function fakeLocationEsi(
  perChar: {
    location?: Record<number, CharacterLocation | "fail">;
    structures?: Record<number, string>;
  } = {},
): { esi: LocationEsi; calls: { online: number[] } } {
  const calls = { online: [] as number[] };
  const esi: LocationEsi = {
    getLocation: async (characterId) => {
      const l = perChar.location?.[characterId] ?? inSpace(31000042);
      if (l === "fail") throw new EsiError("location read failed", 500, "transient");
      return l;
    },
    getOnline: async (characterId) => {
      calls.online.push(characterId);
      return true;
    },
    getSystemName: async (id) => `System ${id}`,
    getStationName: async (id) => `Station ${id}`,
    getStructureName: async (id) => {
      const n = perChar.structures?.[id];
      if (n === "fail") throw new EsiError("no docking access", 403, "permanent");
      return n ?? `Structure ${id}`;
    },
  };
  return { esi, calls };
}

async function row(id: number) {
  const [r] = await ctx.db.select().from(character).where(eq(character.id, id));
  return r;
}

describe("canReadLocation", () => {
  const base = {
    refreshTokenEnc: "enc",
    tokenStatus: "valid" as const,
    scopes: ALL_SCOPES,
  };
  it("gates on the required scope only, never on the optional two", () => {
    expect(canReadLocation(base)).toBe(true);
    expect(canReadLocation({ ...base, scopes: [LOCATION_SCOPE_REQUIRED] })).toBe(true);
    expect(canReadLocation({ ...base, scopes: ["esi-location.read_online.v1"] })).toBe(
      false,
    );
    expect(canReadLocation({ ...base, refreshTokenEnc: null })).toBe(false);
    expect(canReadLocation({ ...base, tokenStatus: "invalid" })).toBe(false);
    expect(canReadLocation({ ...base, tokenStatus: "missing" })).toBe(false);
    expect(canReadLocation({ ...base, tokenStatus: "needs_reauth" })).toBe(true);
  });
});

describe("runLocationJob", () => {
  it("skips a character without the required scope and writes no columns", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: ["esi-characters.read_contacts.v1"],
    });
    const { esi } = fakeLocationEsi();
    const result = await runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.status).toBe("ok");
    expect(result.counts?.skipped).toBe(1);
    expect(result.counts?.updated).toBe(0);
    const r = await row(1);
    expect(r.locationSystemId).toBeNull();
    expect(r.locationCheckedAt).toBeNull();
  });

  it("writes the location with the required scope alone, leaving online null", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: [LOCATION_SCOPE_REQUIRED],
    });
    const { esi, calls } = fakeLocationEsi({ location: { 1: inSpace(31000042) } });
    const result = await runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.status).toBe("ok");
    expect(result.counts?.updated).toBe(1);
    // The missing OPTIONAL scope costs the online flag and nothing else.
    expect(calls.online).toEqual([]);
    const r = await row(1);
    expect(r.locationSystemId).toBe(31000042);
    expect(r.locationOnline).toBeNull();
    expect(r.locationCheckedAt).not.toBeNull();
  });

  it("degrades a failed optional read exactly like a missing optional scope", async () => {
    // Deliberate, user-approved deviation from the reference implementation
    // in the plan: a THROWING optional read (here, getOnline 403s) must be
    // treated identically to the scope simply being absent — the row still
    // writes, the corresponding detail is null, and nothing escalates to
    // needs_reauth or aborts the write. Only a failure on the REQUIRED read
    // (esi.getLocation) may do that; see the transient-failure test above.
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: ALL_SCOPES,
    });
    const esi: LocationEsi = {
      ...fakeLocationEsi({ location: { 1: inSpace(31000042) } }).esi,
      getOnline: async () => {
        throw new EsiError("missing scope", 403, "needs_reauth");
      },
    };
    const result = await runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.status).toBe("ok");
    expect(result.counts?.updated).toBe(1);
    expect(result.counts?.failed).toBe(0);
    const r = await row(1);
    expect(r.locationSystemId).toBe(31000042);
    expect(r.locationOnline).toBeNull();
    expect(r.locationCheckedAt).not.toBeNull();
    // The optional scope's failure must NOT reach the needs_reauth CAS —
    // that branch is reserved for a failure on the REQUIRED read.
    expect(r.tokenStatus).toBe("valid");
  });

  it("records dry-run as a skip so the run still reports ok", async () => {
    // The test that keeps the admin sync page from lighting up amber in a
    // dry-run deployment, where EVERY character refuses the token refresh.
    const dryCfg = testConfig({ SYNC_MODE: "dry-run" });
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: ALL_SCOPES,
    });
    const { esi } = fakeLocationEsi();
    const result = await runLocationJob({
      db: ctx.db,
      cfg: dryCfg,
      esi,
      fetchImpl: okToken,
    });
    expect(result.status).toBe("ok");
    expect(result.counts?.skipped).toBe(1);
    expect(result.counts?.targets).toBe(0);
    expect(result.counts?.failed).toBe(0);
    expect((await row(1)).locationCheckedAt).toBeNull();
  });

  it("keeps the last known values on a transient read failure", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: ALL_SCOPES,
    });
    const before = new Date("2026-08-06T09:00:00Z");
    await ctx.db
      .update(character)
      .set({
        locationSystemId: 31000042,
        locationOnline: true,
        locationCheckedAt: before,
      })
      .where(eq(character.id, 1));

    const { esi } = fakeLocationEsi({ location: { 1: "fail" } });
    await expect(
      runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken }),
    ).rejects.toBeInstanceOf(JobRetryError); // transient → status partial, retry

    const [run] = await ctx.db.select().from(syncRun);
    expect(run.status).toBe("partial");

    const r = await row(1);
    expect(r.locationSystemId).toBe(31000042);
    expect(r.locationOnline).toBe(true);
    // The one that matters: a failed read must NOT advance the clock, or the
    // "as of" label would advertise freshness this row does not have.
    expect(r.locationCheckedAt?.toISOString()).toBe(before.toISOString());
  });

  it("still writes the row when a structure name cannot be resolved", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: ALL_SCOPES,
    });
    // Real EVE id ranges, not adjacent numbers: a structure id can never fall
    // in the solar-system range (src/services/universe-names.ts:55-58 relies
    // on that separation to treat `id` alone as a safe cache key).
    const { esi } = fakeLocationEsi({
      location: { 1: docked(30000142, 1035466617946) },
      structures: { 1035466617946: "fail" },
    });
    const result = await runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    // An unresolvable structure is a steady state, not a job fault.
    expect(result.status).toBe("ok");
    expect(result.counts?.namesUnresolved).toBe(1);
    expect(result.counts?.updated).toBe(1);
    const r = await row(1);
    expect(r.locationStructureId).toBe(1035466617946);
    expect(r.locationCheckedAt).not.toBeNull();
  });

  it("does not let one character's failure abort the run for the others", async () => {
    // Two characters in one run: if the try/catch around a single character's
    // ESI calls were ever hoisted out of the loop, char 1's throw would abort
    // the whole `for` and char 2 would never be updated — updated would read
    // 0, not 1.
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: ALL_SCOPES,
    });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: acc.id,
      scopes: ALL_SCOPES,
    });
    const { esi } = fakeLocationEsi({
      location: { 1: "fail", 2: inSpace(30000142) },
    });
    await expect(
      runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken }),
    ).rejects.toBeInstanceOf(JobRetryError);

    const [run] = await ctx.db.select().from(syncRun);
    expect(run.status).toBe("partial");

    const result = await ctx.db.select().from(character).where(eq(character.id, 2));
    expect(result[0].locationSystemId).toBe(30000142);
    // char 1 failed and wrote nothing; char 2 still updated despite it.
    expect((await row(1)).locationCheckedAt).toBeNull();
  });

  it("marks needs_reauth under a CAS on the refresh-token blob, and does not retry", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: ALL_SCOPES,
    });
    const esi: LocationEsi = {
      ...fakeLocationEsi().esi,
      getLocation: async () => {
        throw new EsiError("missing scope", 403, "needs_reauth");
      },
    };
    const result = await runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    // needs_reauth counts as failed, not transient — retrying would hammer a
    // token that will not improve without operator action.
    expect(result.status).toBe("partial");
    expect(result.retry).toBe(false);
    expect(result.counts?.failed).toBe(1);
    const r = await row(1);
    expect(r.tokenStatus).toBe("needs_reauth");
  });

  it("skips the needs_reauth write when the refresh-token blob rotated underneath it", async () => {
    // Simulates a concurrent rotation landing between this job's token
    // refresh and its needs_reauth write: the CAS predicate must see the row
    // has moved on and refuse to write a decision based on stale state.
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      scopes: ALL_SCOPES,
      tokenStatus: "valid",
    });
    const esi: LocationEsi = {
      ...fakeLocationEsi().esi,
      getLocation: async () => {
        // Land a concurrent rotation of the encrypted refresh token AFTER
        // this job's own refresh already stored its rotated value, but
        // BEFORE the needs_reauth branch runs its CAS update.
        await ctx.db
          .update(character)
          .set({ refreshTokenEnc: "rotated-by-someone-else" })
          .where(eq(character.id, 1));
        throw new EsiError("missing scope", 403, "needs_reauth");
      },
    };
    const result = await runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.status).toBe("partial");
    expect(result.counts?.failed).toBe(1);
    const r = await row(1);
    // The CAS predicate missed (refreshTokenEnc no longer matches what our
    // refresh wrote), so tokenStatus must be left exactly as it was.
    expect(r.tokenStatus).toBe("valid");
    expect(r.refreshTokenEnc).toBe("rotated-by-someone-else");
  });

  it("covers every tier but never an affiliation_invalid character", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const associate = await seedAccount(ctx.db, { tier: "associate" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: member.id,
      main: true,
      scopes: ALL_SCOPES,
    });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: associate.id,
      scopes: ALL_SCOPES,
    });
    await seedCharacter(ctx.db, cfg, {
      id: 3,
      accountId: member.id,
      scopes: ALL_SCOPES,
      affiliationInvalid: true,
    });
    const { esi } = fakeLocationEsi();
    const result = await runLocationJob({ db: ctx.db, cfg, esi, fetchImpl: okToken });
    expect(result.counts?.updated).toBe(2); // the associate counts too
    expect((await row(3)).locationCheckedAt).toBeNull();
  });
});
