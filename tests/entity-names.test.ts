import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { esiEntityName } from "@/db/schema";
import type { EsiEntityName } from "@/lib/esi/client";
import { lookupEntityNames, resolveEntityNames } from "@/services/entity-names";
import { setupTestDb, truncateAll } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

/** Records every id batch it is asked for, so tests can assert cache hits. */
function fakeEsi(names: Record<number, { name: string; category: string }> | "fail") {
  const calls: number[][] = [];
  return {
    calls,
    esi: {
      getUniverseNames: async (ids: number[]): Promise<EsiEntityName[]> => {
        calls.push([...ids]);
        if (names === "fail") throw new Error("esi down");
        return ids
          .filter((id) => names[id] !== undefined)
          .map((id) => ({ id, name: names[id].name, category: names[id].category }));
      },
    },
  };
}

const seedName = (id: number, name: string, kind: "character" | "corporation") =>
  ctx.db.insert(esiEntityName).values({ id, kind, name, fetchedAt: new Date() });

describe("lookupEntityNames", () => {
  it("returns an empty map for no ids, without touching the database", async () => {
    expect(await lookupEntityNames(ctx.db, [])).toEqual(new Map());
  });

  it("returns only the ids it has cached", async () => {
    await seedName(1, "Alice", "character");
    const found = await lookupEntityNames(ctx.db, [1, 2]);
    expect(found.get(1)).toBe("Alice");
    expect(found.has(2)).toBe(false);
  });
});

describe("resolveEntityNames", () => {
  it("returns immediately for an empty id list and never calls ESI", async () => {
    const { esi, calls } = fakeEsi({});
    expect(await resolveEntityNames(ctx.db, esi, [])).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it("serves cached ids without calling ESI at all", async () => {
    await seedName(1, "Alice", "character");
    const { esi, calls } = fakeEsi({});
    const names = await resolveEntityNames(ctx.db, esi, [1]);
    expect(names.get(1)).toBe("Alice");
    expect(calls).toEqual([]);
  });

  it("asks ESI only for the misses, and returns cached plus fresh", async () => {
    await seedName(1, "Alice", "character");
    const { esi, calls } = fakeEsi({
      2: { name: "Bravo Corp", category: "corporation" },
    });
    const names = await resolveEntityNames(ctx.db, esi, [1, 2]);
    expect(calls).toEqual([[2]]);
    expect(names.get(1)).toBe("Alice");
    expect(names.get(2)).toBe("Bravo Corp");
  });

  it("falls through to ESI when the initial cache read itself throws", async () => {
    // A stub dbx whose `select` chain rejects, simulating a dropped connection
    // or timeout on the read — as opposed to every other test here, which
    // fails ESI, not the database. `insert` (and everything else) is left
    // pointing at the real test db so the fetch-and-cache path still works.
    const brokenReadDbx = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return () => ({
            from: () => ({
              where: () => Promise.reject(new Error("connection reset")),
            }),
          });
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return value;
      },
    });
    const { esi, calls } = fakeEsi({ 9: { name: "Foxtrot", category: "character" } });
    const names = await resolveEntityNames(brokenReadDbx, esi, [9]);
    expect(names.get(9)).toBe("Foxtrot");
    expect(calls).toEqual([[9]]);
  });

  it("upserts what it resolves, so the next call needs no ESI", async () => {
    const { esi, calls } = fakeEsi({ 7: { name: "Charlie", category: "character" } });
    await resolveEntityNames(ctx.db, esi, [7]);
    await resolveEntityNames(ctx.db, esi, [7]);
    expect(calls).toEqual([[7]]);
    const rows = await ctx.db.select().from(esiEntityName);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 7, kind: "character", name: "Charlie" });
  });

  it("overwrites a cached name when ESI reports a rename", async () => {
    await seedName(7, "Old Name", "character");
    // Force a miss by resolving an id we do not hold, alongside the stale one.
    const { esi } = fakeEsi({ 8: { name: "Delta", category: "character" } });
    const first = await resolveEntityNames(ctx.db, esi, [7, 8]);
    expect(first.get(7)).toBe("Old Name"); // cache-first: no refetch of a hit
    await ctx.db.delete(esiEntityName);
    const { esi: esi2 } = fakeEsi({ 7: { name: "New Name", category: "character" } });
    const second = await resolveEntityNames(ctx.db, esi2, [7]);
    expect(second.get(7)).toBe("New Name");
  });

  it("NEVER throws — an ESI failure returns whatever was cached", async () => {
    await seedName(1, "Alice", "character");
    const { esi } = fakeEsi("fail");
    const names = await resolveEntityNames(ctx.db, esi, [1, 2]);
    expect(names.get(1)).toBe("Alice");
    expect(names.has(2)).toBe(false);
    expect(await ctx.db.select().from(esiEntityName)).toHaveLength(1);
  });

  it("drops categories the cache does not model rather than failing the batch", async () => {
    // getUniverseNames answers for systems and stations too; the enum has three
    // kinds, so anything else would be a constraint violation on insert.
    const { esi } = fakeEsi({
      1: { name: "Alice", category: "character" },
      2: { name: "Jita", category: "solar_system" },
    });
    const names = await resolveEntityNames(ctx.db, esi, [1, 2]);
    expect(names.get(1)).toBe("Alice");
    expect(names.has(2)).toBe(false);
  });

  it("asks for each unresolved id once even when the caller repeats it", async () => {
    const { esi, calls } = fakeEsi({ 5: { name: "Echo", category: "alliance" } });
    await resolveEntityNames(ctx.db, esi, [5, 5, 5]);
    expect(calls).toEqual([[5]]);
  });
});
