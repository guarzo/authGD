import { describe, expect, it, vi } from "vitest";
import { resolveAffiliations } from "@/core/affiliation";
import { EsiError, type Affiliation } from "@/lib/esi/client";

const okFor = (ids: number[]): Affiliation[] =>
  ids.map((id) => ({ characterId: id, corporationId: id * 10, allianceId: 99000001 }));

describe("resolveAffiliations", () => {
  it("resolves a clean batch", async () => {
    const out = await resolveAffiliations([1, 2, 3], async (ids) => okFor(ids));
    expect(out.resolved.size).toBe(3);
    expect(out.resolved.get(2)).toEqual({ corporationId: 20, allianceId: 99000001 });
    expect(out.invalid).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  it("submits in chunks of at most 500", async () => {
    const sizes: number[] = [];
    const ids = Array.from({ length: 1100 }, (_, i) => i + 1);
    await resolveAffiliations(ids, async (batch) => {
      sizes.push(batch.length);
      return okFor(batch);
    });
    expect(sizes).toEqual([500, 500, 100]);
  });

  it("bisects deterministic 400s down to the bad ids only", async () => {
    const bad = new Set([2, 5]);
    const post = vi.fn(async (ids: number[]): Promise<Affiliation[]> => {
      if (ids.some((id) => bad.has(id))) {
        throw new EsiError("bad id", 400, "permanent");
      }
      return okFor(ids);
    });
    const out = await resolveAffiliations([1, 2, 3, 4, 5, 6], post);
    expect([...out.invalid].sort((a, b) => a - b)).toEqual([2, 5]);
    expect([...out.resolved.keys()].sort((a, b) => a - b)).toEqual([1, 3, 4, 6]);
    expect(out.unresolved).toEqual([]);
  });

  it("NEVER bisects or flags on transient failures", async () => {
    const post = vi.fn(async (): Promise<Affiliation[]> => {
      throw new EsiError("rate limited", 420, "transient");
    });
    const out = await resolveAffiliations([1, 2, 3], post);
    expect(out.invalid).toEqual([]);
    expect([...out.unresolved].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(post).toHaveBeenCalledTimes(1); // no bisection attempts
  });

  it("treats non-400 permanent errors as unresolved, not invalid", async () => {
    const post = async (): Promise<Affiliation[]> => {
      throw new EsiError("not found", 404, "permanent");
    };
    const out = await resolveAffiliations([1, 2], post);
    expect(out.invalid).toEqual([]);
    expect(out.unresolved).toEqual([1, 2]);
  });

  it("marks ids omitted from a successful response as unresolved", async () => {
    const out = await resolveAffiliations([1, 2], async () => okFor([1]));
    expect([...out.resolved.keys()]).toEqual([1]);
    expect(out.unresolved).toEqual([2]);
  });

  it("ignores response rows for ids that were never requested", async () => {
    const out = await resolveAffiliations([1, 2], async () => [
      ...okFor([1, 2]),
      { characterId: 999, corporationId: 9990, allianceId: 99000001 },
    ]);
    expect(out.resolved.has(999)).toBe(false);
    expect([...out.resolved.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("keeps the first row when the response duplicates an id", async () => {
    const out = await resolveAffiliations([1], async () => [
      { characterId: 1, corporationId: 10, allianceId: 99000001 },
      { characterId: 1, corporationId: 20, allianceId: null },
    ]);
    expect(out.resolved.get(1)).toEqual({ corporationId: 10, allianceId: 99000001 });
    expect(out.unresolved).toEqual([]);
  });
});
