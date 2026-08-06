import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { universeName } from "@/db/schema";
import { EsiError } from "@/lib/esi/client";
import {
  STRUCTURE_TTL_MS,
  isCacheFresh,
  lookupCachedNames,
  resolveUniverseName,
  type NameResolver,
} from "@/services/universe-names";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

type Calls = { system: number; station: number; structure: number };

/** Fake resolver: counts calls, and can be made to throw per kind. */
function fakeNames(opts: { fail?: Array<keyof Calls> } = {}): {
  esi: NameResolver;
  calls: Calls;
} {
  const calls: Calls = { system: 0, station: 0, structure: 0 };
  const fail = new Set(opts.fail ?? []);
  const esi: NameResolver = {
    getSystemName: async (id) => {
      calls.system++;
      if (fail.has("system")) throw new EsiError("boom", 500, "transient");
      return `System ${id}`;
    },
    getStationName: async (id) => {
      calls.station++;
      if (fail.has("station")) throw new EsiError("boom", 500, "transient");
      return `Station ${id}`;
    },
    getStructureName: async (id) => {
      calls.structure++;
      if (fail.has("structure")) throw new EsiError("no access", 403, "permanent");
      return `Structure ${id}`;
    },
  };
  return { esi, calls };
}

const AT = "access-token";

describe("isCacheFresh", () => {
  const now = new Date("2026-08-06T12:00:00Z");
  const longAgo = new Date(now.getTime() - 10 * STRUCTURE_TTL_MS);

  it("treats systems and stations as immutable", () => {
    expect(isCacheFresh("system", longAgo, now)).toBe(true);
    expect(isCacheFresh("station", longAgo, now)).toBe(true);
  });

  it("expires structures after the TTL", () => {
    expect(isCacheFresh("structure", new Date(now.getTime() - 1000), now)).toBe(true);
    expect(
      isCacheFresh("structure", new Date(now.getTime() - STRUCTURE_TTL_MS), now),
    ).toBe(false);
    expect(isCacheFresh("structure", longAgo, now)).toBe(false);
  });
});

describe("resolveUniverseName", () => {
  it("returns the cached name without calling ESI", async () => {
    await ctx.db
      .insert(universeName)
      .values({ id: 30000142, kind: "system", name: "Jita" });
    const { esi, calls } = fakeNames();
    const name = await resolveUniverseName(ctx.db, esi, {
      id: 30000142,
      kind: "system",
      accessToken: AT,
    });
    expect(name).toBe("Jita");
    expect(calls.system).toBe(0);
  });

  it("fetches and caches on a miss", async () => {
    const { esi, calls } = fakeNames();
    const first = await resolveUniverseName(ctx.db, esi, {
      id: 31000001,
      kind: "structure",
      accessToken: AT,
    });
    expect(first).toBe("Structure 31000001");
    expect(calls.structure).toBe(1);

    const second = await resolveUniverseName(ctx.db, esi, {
      id: 31000001,
      kind: "structure",
      accessToken: AT,
    });
    expect(second).toBe("Structure 31000001");
    expect(calls.structure).toBe(1); // served from the row the first call wrote
  });

  it("refetches a structure once its row is past the TTL", async () => {
    await ctx.db.insert(universeName).values({
      id: 31000002,
      kind: "structure",
      name: "Old Name",
      fetchedAt: new Date(Date.now() - STRUCTURE_TTL_MS - 60_000),
    });
    const { esi, calls } = fakeNames();
    const name = await resolveUniverseName(ctx.db, esi, {
      id: 31000002,
      kind: "structure",
      accessToken: AT,
    });
    expect(name).toBe("Structure 31000002");
    expect(calls.structure).toBe(1);
  });

  it("returns null instead of throwing when ESI fails and nothing is cached", async () => {
    const { esi } = fakeNames({ fail: ["structure"] });
    await expect(
      resolveUniverseName(ctx.db, esi, {
        id: 31000003,
        kind: "structure",
        accessToken: AT,
      }),
    ).resolves.toBeNull();
  });

  it("prefers a STALE cached name over null when the refetch fails", async () => {
    // The whole point: a renamed citadel we can no longer read would otherwise
    // read "Docked" forever, because the failing call is the only way out.
    await ctx.db.insert(universeName).values({
      id: 31000004,
      kind: "structure",
      name: "Home Astrahus",
      fetchedAt: new Date(Date.now() - STRUCTURE_TTL_MS - 60_000),
    });
    const { esi, calls } = fakeNames({ fail: ["structure"] });
    const name = await resolveUniverseName(ctx.db, esi, {
      id: 31000004,
      kind: "structure",
      accessToken: AT,
    });
    expect(calls.structure).toBe(1); // it did try
    expect(name).toBe("Home Astrahus");
  });
});

describe("lookupCachedNames", () => {
  it("returns a Map of the ids it has, and never calls ESI", async () => {
    await ctx.db.insert(universeName).values([
      { id: 30000142, kind: "system", name: "Jita" },
      { id: 31000001, kind: "structure", name: "Home Astrahus" },
    ]);
    const names = await lookupCachedNames(ctx.db, [30000142, 31000001, 99999999]);
    expect(names.get(30000142)).toBe("Jita");
    expect(names.get(31000001)).toBe("Home Astrahus");
    expect(names.has(99999999)).toBe(false);
    expect(names.size).toBe(2);
  });

  it("handles an empty id list without querying", async () => {
    const names = await lookupCachedNames(ctx.db, []);
    expect(names.size).toBe(0);
  });
});
