import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runStructuresJob } from "@/jobs/structures";
import {
  EsiError,
  NOTIFICATIONS_SCOPE,
  STRUCTURES_SCOPE,
  type EsiCorporationStructure,
  type StructuresEsi,
} from "@/lib/esi/client";
import { classifyEsiError } from "@/core/errors";
import {
  designateStructureHolder,
  getReadStates,
  getRoster,
} from "@/services/structures";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const CORP = 98000001;
const HOLDER = 90000001;

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

function fakeEsi(opts: {
  structures?: EsiCorporationStructure[];
  error?: Error;
}): StructuresEsi {
  return {
    getCorporationStructures: async () => {
      if (opts.error) throw opts.error;
      return opts.structures ?? [];
    },
    getUniverseNames: async (ids: number[]) =>
      ids.map((id) => ({ id, name: `name-${id}`, category: "inventory_type" })),
  };
}

function struct(id: number, over: Partial<EsiCorporationStructure> = {}) {
  return {
    structureId: id,
    typeId: 35832,
    systemId: 30004268,
    name: `S${id}`,
    state: "shield_vulnerable",
    stateTimerStart: null,
    stateTimerEnd: null,
    fuelExpires: null,
    ...over,
  };
}

/**
 * Designates a holder pinned to CORP, with both scopes granted and a live
 * token, and optionally moves the character's CURRENT corp elsewhere so the
 * corp-changed branch can be exercised.
 */
async function designate(opts: { currentCorp?: number; scopes?: string[] } = {}) {
  const account = await seedAccount(ctx.db);
  await seedCharacter(ctx.db, testConfig(), {
    id: HOLDER,
    accountId: account.id,
    corporationId: opts.currentCorp ?? CORP,
    scopes: opts.scopes ?? [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
    tokenStatus: "valid",
    // The helper encrypts this with the test key itself — never pass a
    // pre-encrypted blob (tests/helpers/seed.ts:33-50).
    refreshToken: "refresh",
  });
  await designateStructureHolder(ctx.db, HOLDER, CORP, account.id);
  return account;
}

function run(esi: StructuresEsi, fetchImpl = okToken) {
  return runStructuresJob({ db: ctx.db, cfg: testConfig(), esi, fetchImpl });
}

describe("runStructuresJob", () => {
  it("returns ok with noHolder when nothing is designated", async () => {
    const res = await run(fakeEsi({}));
    expect(res.status).toBe("ok");
    expect(res.counts?.noHolder).toBe(1);
  });

  it("does not call ESI when the holder lacks the scope", async () => {
    await designate({ scopes: [] });
    let called = false;
    const esi: StructuresEsi = {
      getCorporationStructures: async () => {
        called = true;
        return [];
      },
      getUniverseNames: async () => [],
    };
    const res = await run(esi);
    expect(called).toBe(false);
    expect(res.counts?.scopeMissing).toBe(1);
  });

  it("refuses to read when the holder has left the pinned corporation", async () => {
    await designate({ currentCorp: 98000002 });
    const res = await run(fakeEsi({ structures: [struct(1)] }));
    expect(res.counts?.corpChanged).toBe(1);
    const states = await getReadStates(ctx.db, CORP);
    expect(states.roster.readStatus).toBe("failed");
    expect(states.roster.detail).toBe("corp-changed");
    expect(await getRoster(ctx.db, CORP)).toHaveLength(0);
  });

  it("records forbidden and mutates no roster rows on a corp-roles 403", async () => {
    await designate();
    await run(fakeEsi({ structures: [struct(1)] })); // one good read first
    const res = await run(
      fakeEsi({
        error: new EsiError("Character does not have required role(s)", 403, "permanent"),
      }),
    );
    expect(res.status).toBe("partial");
    const states = await getReadStates(ctx.db, CORP);
    expect(states.roster.readStatus).toBe("forbidden");
    // the last GOOD read's timestamp survives the failure
    expect(states.roster.observedAt).toBeInstanceOf(Date);
    const rows = await getRoster(ctx.db, CORP);
    expect(rows).toHaveLength(1);
    expect(rows[0].missingSince).toBeNull();
  });

  it("pins a corp-roles 403 as permanent, not needs_reauth", () => {
    // Load-bearing on CCP's error PROSE: classifyEsiError maps 403 to
    // needs_reauth only when the body names a scope/token/authorization
    // problem. If CCP reworded this, `forbidden` would start reading as a
    // token fault and send admins round the re-auth loop forever.
    expect(
      classifyEsiError(403, { error: "Character does not have required role(s)" }),
    ).toBe("permanent");
    expect(classifyEsiError(403, { error: "invalid token" })).toBe("needs_reauth");
  });

  it("stamps missingSince rather than deleting a structure that stopped appearing", async () => {
    await designate();
    await run(fakeEsi({ structures: [struct(1), struct(2)] }));
    await run(fakeEsi({ structures: [struct(1)] }));
    const rows = await getRoster(ctx.db, CORP);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.structureId === 2)?.missingSince).toBeInstanceOf(Date);
    expect(rows.find((r) => r.structureId === 1)?.missingSince).toBeNull();
  });

  it("clears missingSince when a structure reappears", async () => {
    await designate();
    await run(fakeEsi({ structures: [struct(1), struct(2)] }));
    await run(fakeEsi({ structures: [struct(1)] }));
    await run(fakeEsi({ structures: [struct(1), struct(2)] }));
    const rows = await getRoster(ctx.db, CORP);
    expect(rows.find((r) => r.structureId === 2)?.missingSince).toBeNull();
  });

  it("keeps a good type name when the name lookup fails", async () => {
    await designate();
    await run(fakeEsi({ structures: [struct(1)] }));
    const esi: StructuresEsi = {
      getCorporationStructures: async () => [struct(1)],
      getUniverseNames: async () => {
        throw new Error("names down");
      },
    };
    await run(esi);
    expect((await getRoster(ctx.db, CORP))[0].typeName).toBe("name-35832");
  });
});
